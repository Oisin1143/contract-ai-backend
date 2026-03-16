require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const cheerio = require("cheerio");
const rateLimit = require("express-rate-limit");


const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "50kb" }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many requests — please wait 15 minutes and try again." },
});

app.use("/analyse", limiter);

// ── Health check ──
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Contract AI backend running" });
});

// ── Generate BAILII search links directly from case names ──
function generateBailiiLinks(text) {
  const citations = new Set();
  const pattern = /([A-Z][a-zA-Z\s&'.]+\sv\s[A-Z][a-zA-Z\s&'.]+)/g;
  const matches = text.matchAll(pattern);
  for (const match of matches) {
    const name = match[1].trim();
    if (name.length > 5 && name.length < 80) citations.add(name);
  }
  return [...citations].slice(0, 8).map(name => ({
    name,
    url: `https://www.bailii.org/cgi-bin/lucy_search_1.cgi?query=${encodeURIComponent(name)}&method=boolean&mask_path=uk%2Fcases%2FEWCA+uk%2Fcases%2FEWHC+uk%2Fcases%2FUKSC+uk%2Fcases%2FUKHL`,
    verified: false,
  }));
}

// ── Main analyse endpoint ──
app.post("/analyse", async (req, res) => {
  const { contractText, disputeDesc } = req.body;

  if (!contractText || !disputeDesc) {
    return res.status(400).json({ error: "contractText and disputeDesc are required." });
  }

  const GROQ_KEY = process.env.GROQ_KEY;
  if (!GROQ_KEY) {
    return res.status(500).json({ error: "Server misconfiguration: missing API key." });
  }

  const prompt = `You are a senior UK contract law barrister. Analyse the contract and dispute below thoroughly.

CONTRACT TEXT:
"""
${contractText}
"""

DISPUTE DESCRIPTION:
"""
${disputeDesc}
"""

Provide your COMPLETE analysis using EXACTLY these headings:

## KEY LEGAL ISSUES & BREACH
List all key legal issues as numbered points:
1. **Issue Title:** Full explanation specific to the contract clauses.

## ARGUMENTS FOR BOTH SIDES
**Claimant:**
1. **Argument Title:** Full explanation referencing specific contract clauses.

**Defendant:**
1. **Argument Title:** Full explanation.

## RELEVANT UK CASE LAW & STATUTES
1. **Case Name [citation]:** How it applies to this dispute.

## LIKELY OUTCOME & RISK ASSESSMENT
1. **Factor:** Explanation. State HIGH RISK, MEDIUM RISK, or LOW RISK for the claimant.

## OVERALL PROBABILITY
Claimant win probability: [X]%
Defendant win probability: [Y]%
Reasoning: [2-3 sentences explaining the split based on strength of arguments and applicable UK case law.]`;

  try {
    // ── Call Groq ──
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${GROQ_KEY}`,
      },
      body: JSON.stringify({
        model:       "llama-3.3-70b-versatile",
        messages:    [{ role: "user", content: prompt }],
        max_tokens:  4000,
        temperature: 0.3,
      }),
    });

    if (!groqRes.ok) {
      const err = await groqRes.json();
      throw new Error(err?.error?.message || `Groq error ${groqRes.status}`);
    }

    const groqData = await groqRes.json();
    const fullText = groqData.choices?.[0]?.message?.content || "";
    if (!fullText) throw new Error("Empty response from Groq.");

    // ── Generate BAILII links from citations ──
    const bailiiLinks = generateBailiiLinks(fullText);

    res.json({ result: fullText, bailiiLinks });

  } catch (e) {
    console.error("Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));