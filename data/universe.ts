// The investor's universe: mock portfolio, ad-hoc research picks, and a small
// company directory used to resolve employer names (in bios / network profiles)
// to listed companies and sectors. The research engine itself is NOT limited to
// this list — any NSE symbol works; this only improves entity matching.

export type Company = {
  symbol: string;
  name: string;
  sector: string;
  themes: string[];
  aliases?: string[];
  size: "large" | "mid" | "small";
};

export const PORTFOLIO: Company[] = [
  { symbol: "RELIANCE", name: "Reliance Industries", sector: "Energy & Telecom", themes: ["energy", "telecom", "retail"], aliases: ["RIL", "Jio", "Reliance Retail"], size: "large" },
  { symbol: "TCS", name: "Tata Consultancy Services", sector: "IT Services", themes: ["it services", "ai"], aliases: ["Tata Consultancy"], size: "large" },
  { symbol: "HDFCBANK", name: "HDFC Bank", sector: "Banking", themes: ["banking", "retail lending"], aliases: ["HDFC"], size: "large" },
  { symbol: "BAJFINANCE", name: "Bajaj Finance", sector: "NBFC", themes: ["consumer lending", "nbfc"], aliases: ["Bajaj Finserv"], size: "large" },
  { symbol: "TITAN", name: "Titan Company", sector: "Consumer Discretionary", themes: ["jewellery", "consumer", "retail"], aliases: ["Titan", "Tanishq"], size: "large" },
  { symbol: "ASIANPAINT", name: "Asian Paints", sector: "Paints", themes: ["consumer", "paints", "building materials"], aliases: ["Asian Paints"], size: "large" },
  { symbol: "SUNPHARMA", name: "Sun Pharmaceutical", sector: "Pharma", themes: ["pharma", "us generics", "specialty pharma"], aliases: ["Sun Pharma"], size: "large" },
  { symbol: "MARUTI", name: "Maruti Suzuki", sector: "Automobiles", themes: ["autos", "ev"], aliases: ["Maruti", "Maruti Suzuki India"], size: "large" },
  { symbol: "LT", name: "Larsen & Toubro", sector: "Capital Goods", themes: ["infrastructure", "capex", "defence"], aliases: ["L&T", "Larsen and Toubro"], size: "large" },
  { symbol: "TRENT", name: "Trent", sector: "Retail", themes: ["retail", "consumer", "apparel"], aliases: ["Westside", "Zudio"], size: "large" },
  { symbol: "PIDILITIND", name: "Pidilite Industries", sector: "Chemicals", themes: ["specialty chemicals", "consumer"], aliases: ["Pidilite"], size: "large" },
  { symbol: "INDHOTEL", name: "Indian Hotels", sector: "Hotels", themes: ["hospitality", "consumer"], aliases: ["IHCL", "Taj Hotels"], size: "mid" },
  { symbol: "POLYCAB", name: "Polycab India", sector: "Electricals", themes: ["cables", "electricals", "capex"], aliases: ["Polycab"], size: "mid" },
  { symbol: "DIXON", name: "Dixon Technologies", sector: "Electronics Manufacturing", themes: ["electronics manufacturing", "semiconductors", "pli"], aliases: ["Dixon"], size: "mid" },
  { symbol: "DEEPAKNTR", name: "Deepak Nitrite", sector: "Chemicals", themes: ["specialty chemicals", "phenol"], aliases: ["Deepak Nitrite", "Deepak Phenolics"], size: "mid" },
  { symbol: "CREDITACC", name: "CreditAccess Grameen", sector: "Microfinance", themes: ["rural lending", "microfinance"], aliases: ["CreditAccess"], size: "mid" },
  { symbol: "CDSL", name: "Central Depository Services", sector: "Capital Markets", themes: ["capital markets", "fintech"], aliases: ["CDSL"], size: "mid" },
  { symbol: "KAYNES", name: "Kaynes Technology", sector: "Electronics Manufacturing", themes: ["electronics manufacturing", "semiconductors", "osat"], aliases: ["Kaynes"], size: "small" },
];

// Ad-hoc research demo set (outside the portfolio). The engine works on any NSE symbol.
export const RESEARCH_PICKS = ["PERSISTENT", "HAL", "VBL", "NAVINFLUOR", "TITAN"];

// Non-listed / other employers that show up in careers — used for entity resolution.
export const OTHER_ORGS: { name: string; aliases: string[]; sector: string; themes: string[] }[] = [
  { name: "Hindustan Unilever", aliases: ["HUL", "Unilever"], sector: "FMCG", themes: ["consumer", "fmcg"] },
  { name: "Procter & Gamble", aliases: ["P&G", "Procter and Gamble"], sector: "FMCG", themes: ["consumer"] },
  { name: "McKinsey & Company", aliases: ["McKinsey"], sector: "Consulting", themes: ["strategy"] },
  { name: "Deloitte", aliases: ["Deloitte Haskins", "Deloitte Touche"], sector: "Audit", themes: ["audit", "accounting"] },
  { name: "KPMG", aliases: [], sector: "Audit", themes: ["audit", "accounting"] },
  { name: "PwC", aliases: ["Price Waterhouse", "PricewaterhouseCoopers"], sector: "Audit", themes: ["audit"] },
  { name: "EY", aliases: ["Ernst & Young", "S.R. Batliboi"], sector: "Audit", themes: ["audit"] },
  { name: "ICICI Bank", aliases: ["ICICI"], sector: "Banking", themes: ["banking"] },
  { name: "Kotak Mahindra Bank", aliases: ["Kotak"], sector: "Banking", themes: ["banking", "capital markets"] },
  { name: "Axis Bank", aliases: ["Axis"], sector: "Banking", themes: ["banking"] },
  { name: "Infosys", aliases: [], sector: "IT Services", themes: ["it services"] },
  { name: "Wipro", aliases: [], sector: "IT Services", themes: ["it services"] },
  { name: "Tata Steel", aliases: [], sector: "Metals", themes: ["metals"] },
  { name: "Tata Motors", aliases: [], sector: "Automobiles", themes: ["autos", "ev"] },
  { name: "Mahindra & Mahindra", aliases: ["Mahindra", "M&M"], sector: "Automobiles", themes: ["autos", "rural"] },
  { name: "Samsung", aliases: ["Samsung India"], sector: "Electronics", themes: ["electronics manufacturing", "semiconductors"] },
  { name: "Foxconn", aliases: ["Hon Hai"], sector: "Electronics Manufacturing", themes: ["electronics manufacturing"] },
  { name: "Micron", aliases: ["Micron Technology"], sector: "Semiconductors", themes: ["semiconductors"] },
  { name: "Aarti Industries", aliases: ["Aarti"], sector: "Chemicals", themes: ["specialty chemicals"] },
  { name: "SRF", aliases: [], sector: "Chemicals", themes: ["specialty chemicals", "fluorochemicals"] },
  { name: "Bandhan Bank", aliases: ["Bandhan"], sector: "Banking", themes: ["rural lending", "microfinance"] },
  { name: "Ujjivan", aliases: ["Ujjivan Small Finance Bank"], sector: "Banking", themes: ["rural lending", "microfinance"] },
  { name: "Berger Paints", aliases: ["Berger"], sector: "Paints", themes: ["paints"] },
  { name: "Kalyan Jewellers", aliases: ["Kalyan"], sector: "Consumer Discretionary", themes: ["jewellery"] },
  { name: "Avenue Supermarts", aliases: ["DMart", "D-Mart"], sector: "Retail", themes: ["retail"] },
  { name: "Cipla", aliases: [], sector: "Pharma", themes: ["pharma"] },
  { name: "Dr. Reddy's", aliases: ["Dr Reddys", "Dr. Reddy's Laboratories"], sector: "Pharma", themes: ["pharma", "us generics"] },
  { name: "SEBI", aliases: ["Securities and Exchange Board of India"], sector: "Regulator", themes: ["capital markets", "regulation"] },
  { name: "NSDL", aliases: [], sector: "Capital Markets", themes: ["capital markets"] },
  { name: "Hindustan Aeronautics", aliases: ["HAL"], sector: "Defence", themes: ["defence"] },
  { name: "Persistent Systems", aliases: ["Persistent"], sector: "IT Services", themes: ["it services", "ai"] },
  { name: "Varun Beverages", aliases: ["VBL", "PepsiCo bottler"], sector: "FMCG", themes: ["consumer", "beverages"] },
  { name: "Navin Fluorine", aliases: ["Navin Fluorine International", "NFIL"], sector: "Chemicals", themes: ["specialty chemicals", "fluorochemicals"] },
];

export function findPortfolio(symbol: string) {
  return PORTFOLIO.find((c) => c.symbol === symbol.toUpperCase());
}
