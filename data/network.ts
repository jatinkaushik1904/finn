// SYNTHETIC network. Every person here is fictional. Their employers are real
// companies so that the network overlaps with the portfolio. In production this
// would be the investor's own uploaded contacts + consented profile data
// (see README: "Network data & privacy").

export type Stint = { org: string; role: string; from: number; to?: number }; // to undefined = current
export type Edu = { school: string; degree: string; from: number; to: number };

export type Contact = {
  id: string;
  name: string;
  headline: string;
  city: string;
  tie: "close" | "friend" | "professional" | "acquaintance";
  howMet: string;
  lastSpoke: string; // ISO date
  career: Stint[];
  education: Edu[];
  expertise: string[];
  knows: string[]; // ids of other contacts they're close to (graph edges)
};

export const INVESTOR = {
  name: "You",
  education: [
    { school: "IIT Delhi", degree: "B.Tech", from: 2014, to: 2018 },
    { school: "IIM Ahmedabad", degree: "MBA", from: 2020, to: 2022 },
  ] as Edu[],
  career: [
    { org: "Kotak Mahindra Bank", role: "Equity Research Associate", from: 2018, to: 2020 },
    { org: "ENAM", role: "Investment Analyst", from: 2022 },
  ] as Stint[],
};

export const CONTACTS: Contact[] = [
  {
    id: "priya", name: "Priya Raman", headline: "VP Finance, Titan Company", city: "Bengaluru", tie: "friend",
    howMet: "IIM Ahmedabad batchmate", lastSpoke: "2026-04-12",
    career: [{ org: "Hindustan Unilever", role: "Finance Manager", from: 2016, to: 2020 }, { org: "Titan Company", role: "VP Finance, Jewellery", from: 2020 }],
    education: [{ school: "IIM Ahmedabad", degree: "MBA", from: 2020, to: 2022 }, { school: "SRCC", degree: "B.Com", from: 2011, to: 2014 }],
    expertise: ["jewellery", "consumer", "retail", "gold pricing"], knows: ["arjun", "kavya"],
  },
  {
    id: "arjun", name: "Arjun Mehta", headline: "Ex-Head of Supply Chain, Trent", city: "Mumbai", tie: "professional",
    howMet: "Met at Trent store visit, 2024", lastSpoke: "2025-11-02",
    career: [{ org: "Avenue Supermarts", role: "Category Head", from: 2012, to: 2018 }, { org: "Trent", role: "Head of Supply Chain", from: 2018, to: 2025 }, { org: "Reliance Industries", role: "Director, Fashion Sourcing (Reliance Retail)", from: 2025 }],
    education: [{ school: "NMIMS", degree: "MBA", from: 2010, to: 2012 }],
    expertise: ["retail", "apparel", "supply chain", "value fashion"], knows: ["priya"],
  },
  {
    id: "kavya", name: "Kavya Iyer", headline: "Partner, Audit — Deloitte", city: "Mumbai", tie: "close",
    howMet: "School friend (DPS R.K. Puram)", lastSpoke: "2026-10-20",
    career: [{ org: "Deloitte", role: "Audit Partner, Consumer & Retail", from: 2012 }],
    education: [{ school: "ICAI", degree: "Chartered Accountant", from: 2010, to: 2013 }],
    expertise: ["audit", "accounting", "related-party transactions", "consumer"], knows: ["priya", "rahul"],
  },
  {
    id: "rahul", name: "Rahul Khanna", headline: "Director, Dixon Technologies (Mobiles)", city: "Noida", tie: "professional",
    howMet: "Plant visit, Noida, Mar 2025", lastSpoke: "2025-03-18",
    career: [{ org: "Samsung", role: "Manufacturing Lead", from: 2010, to: 2017 }, { org: "Dixon Technologies", role: "Director, Mobile Manufacturing", from: 2017 }],
    education: [{ school: "IIT Delhi", degree: "B.Tech Mechanical", from: 2006, to: 2010 }],
    expertise: ["electronics manufacturing", "pli", "mobiles", "semiconductors"], knows: ["sneha", "vikram"],
  },
  {
    id: "sneha", name: "Sneha Kulkarni", headline: "Program Manager, Micron India ATMP", city: "Sanand", tie: "acquaintance",
    howMet: "SEMICON India 2025 panel", lastSpoke: "2025-09-11",
    career: [{ org: "Kaynes Technology", role: "Engineering Manager, OSAT", from: 2018, to: 2023 }, { org: "Micron", role: "Program Manager, ATMP", from: 2023 }],
    education: [{ school: "IIT Delhi", degree: "M.Tech Microelectronics", from: 2016, to: 2018 }],
    expertise: ["semiconductors", "osat", "electronics manufacturing"], knows: ["rahul"],
  },
  {
    id: "vikram", name: "Vikram Sethi", headline: "CFO, mid-size EMS company (unlisted)", city: "Gurugram", tie: "friend",
    howMet: "Ex-colleague at Kotak Institutional Equities", lastSpoke: "2026-08-30",
    career: [{ org: "Kotak Mahindra Bank", role: "Analyst, Kotak Institutional Equities", from: 2016, to: 2020 }, { org: "Dixon Technologies", role: "Strategy & IR", from: 2020, to: 2023 }, { org: "Unlisted EMS company", role: "CFO", from: 2023 }],
    education: [{ school: "IIT Delhi", degree: "B.Tech Electrical", from: 2012, to: 2016 }],
    expertise: ["electronics manufacturing", "investor relations", "capital markets"], knows: ["rahul", "meera"],
  },
  {
    id: "meera", name: "Meera Joshi", headline: "Senior Credit Analyst, CRISIL Ratings", city: "Mumbai", tie: "professional",
    howMet: "Credit conference, 2024", lastSpoke: "2026-02-14",
    career: [{ org: "ICICI Bank", role: "Credit Manager, SME", from: 2014, to: 2019 }, { org: "CRISIL", role: "Senior Credit Analyst, NBFC & Microfinance", from: 2019 }],
    education: [{ school: "IIM Ahmedabad", degree: "PGP", from: 2012, to: 2014 }],
    expertise: ["credit ratings", "nbfc", "microfinance", "rural lending"], knows: ["anand", "vikram"],
  },
  {
    id: "anand", name: "Anand Gowda", headline: "Regional Head, CreditAccess Grameen (Karnataka)", city: "Bengaluru", tie: "acquaintance",
    howMet: "Field trip to Mysuru branches, 2025", lastSpoke: "2025-06-05",
    career: [{ org: "Ujjivan", role: "Area Manager", from: 2011, to: 2016 }, { org: "CreditAccess Grameen", role: "Regional Business Head", from: 2016 }],
    education: [{ school: "University of Agricultural Sciences, Bengaluru", degree: "M.Sc", from: 2008, to: 2010 }],
    expertise: ["rural lending", "microfinance", "collections"], knows: ["meera"],
  },
  {
    id: "rohan", name: "Rohan Desai", headline: "Process Head, Deepak Nitrite (Phenolics)", city: "Vadodara", tie: "friend",
    howMet: "IIT Delhi hostel-mate (Kumaon)", lastSpoke: "2026-09-21",
    career: [{ org: "Aarti Industries", role: "Process Engineer", from: 2018, to: 2021 }, { org: "Deepak Nitrite", role: "Process Head, Phenolics", from: 2021 }],
    education: [{ school: "IIT Delhi", degree: "B.Tech Chemical", from: 2014, to: 2018 }],
    expertise: ["specialty chemicals", "phenol", "plant operations", "capex execution"], knows: ["ishita"],
  },
  {
    id: "ishita", name: "Ishita Bose", headline: "Ex-Strategy, SRF Chemicals; now independent consultant", city: "Delhi", tie: "professional",
    howMet: "Expert call, Jan 2025", lastSpoke: "2025-01-22",
    career: [{ org: "McKinsey & Company", role: "Engagement Manager", from: 2013, to: 2018 }, { org: "SRF", role: "GM Strategy, Chemicals", from: 2018, to: 2024 }, { org: "Independent", role: "Chemicals consultant", from: 2024 }],
    education: [{ school: "IIT Bombay", degree: "B.Tech Chemical", from: 2007, to: 2011 }],
    expertise: ["specialty chemicals", "fluorochemicals", "agrochemicals"], knows: ["rohan"],
  },
  {
    id: "nikhil", name: "Nikhil Agarwal", headline: "Product Lead, Bajaj Finance (Digital Lending)", city: "Pune", tie: "friend",
    howMet: "IIT Delhi batchmate", lastSpoke: "2026-06-30",
    career: [{ org: "Infosys", role: "Software Engineer", from: 2018, to: 2020 }, { org: "Bajaj Finance", role: "Product Lead, Digital Lending", from: 2020 }],
    education: [{ school: "IIT Delhi", degree: "B.Tech CSE", from: 2014, to: 2018 }],
    expertise: ["consumer lending", "fintech", "nbfc"], knows: ["tara", "meera"],
  },
  {
    id: "tara", name: "Tara Menon", headline: "Head of Risk, HDFC Bank (Retail Assets)", city: "Mumbai", tie: "professional",
    howMet: "Bank investor day, 2024", lastSpoke: "2024-12-10",
    career: [{ org: "Axis Bank", role: "Risk Manager", from: 2009, to: 2015 }, { org: "HDFC Bank", role: "Head of Risk, Retail Assets", from: 2015 }],
    education: [{ school: "IIM Bangalore", degree: "PGP", from: 2007, to: 2009 }],
    expertise: ["banking", "retail lending", "credit risk"], knows: ["nikhil"],
  },
  {
    id: "sameer", name: "Sameer Kapoor", headline: "Senior Manager, Asian Paints (Home Décor)", city: "Mumbai", tie: "acquaintance",
    howMet: "Met at dealer meet, 2025", lastSpoke: "2025-07-15",
    career: [{ org: "Berger Paints", role: "Area Sales Manager", from: 2013, to: 2019 }, { org: "Asian Paints", role: "Senior Manager, Home Décor", from: 2019 }],
    education: [{ school: "XLRI", degree: "PGDM", from: 2011, to: 2013 }],
    expertise: ["paints", "building materials", "dealer channels"], knows: ["kavya"],
  },
  {
    id: "devika", name: "Devika Rao", headline: "VP Regulatory Affairs, Sun Pharma", city: "Mumbai", tie: "professional",
    howMet: "Healthcare conference, 2024", lastSpoke: "2025-10-01",
    career: [{ org: "Dr. Reddy's", role: "Regulatory Lead, US", from: 2010, to: 2018 }, { org: "Sun Pharmaceutical", role: "VP Regulatory Affairs", from: 2018 }],
    education: [{ school: "NIPER Mohali", degree: "M.Pharm", from: 2008, to: 2010 }],
    expertise: ["pharma", "us generics", "usfda", "specialty pharma"], knows: [],
  },
  {
    id: "karan", name: "Karan Malhotra", headline: "Engineering Manager, TCS (AI Platforms)", city: "Pune", tie: "close",
    howMet: "Cousin", lastSpoke: "2026-10-28",
    career: [{ org: "Tata Consultancy Services", role: "Engineering Manager, AI Platforms", from: 2015 }],
    education: [{ school: "BITS Pilani", degree: "B.E.", from: 2011, to: 2015 }],
    expertise: ["it services", "ai", "deal pipeline"], knows: ["nikhil"],
  },
  {
    id: "aditi", name: "Aditi Shah", headline: "Associate Director, L&T (Defence & Aerospace)", city: "Mumbai", tie: "acquaintance",
    howMet: "Aero India 2025", lastSpoke: "2025-02-14",
    career: [{ org: "Hindustan Aeronautics", role: "Design Engineer", from: 2010, to: 2016 }, { org: "Larsen & Toubro", role: "Associate Director, Defence", from: 2016 }],
    education: [{ school: "IIT Delhi", degree: "M.Tech Aerospace", from: 2008, to: 2010 }],
    expertise: ["defence", "infrastructure", "capex", "order books"], knows: [],
  },
  {
    id: "farhan", name: "Farhan Qureshi", headline: "GM Operations, IHCL (Taj, North India)", city: "Delhi", tie: "acquaintance",
    howMet: "Friend of Priya (wedding, 2023)", lastSpoke: "2024-02-20",
    career: [{ org: "Indian Hotels", role: "GM Operations, North", from: 2014 }],
    education: [{ school: "IHM Pusa", degree: "BHM", from: 2006, to: 2009 }],
    expertise: ["hospitality", "travel demand"], knows: ["priya"],
  },
  {
    id: "neha", name: "Neha Bansal", headline: "Product Manager, CDSL", city: "Mumbai", tie: "professional",
    howMet: "Fintech meetup, 2025", lastSpoke: "2025-05-08",
    career: [{ org: "NSDL", role: "Business Analyst", from: 2016, to: 2021 }, { org: "Central Depository Services", role: "Product Manager", from: 2021 }],
    education: [{ school: "IIT Delhi", degree: "B.Tech", from: 2012, to: 2016 }],
    expertise: ["capital markets", "fintech", "demat accounts"], knows: [],
  },
  {
    id: "gautam", name: "Gautam Rao", headline: "Ex-Maruti Suzuki (Powertrain), now EV start-up founder", city: "Gurugram", tie: "friend",
    howMet: "IIM Ahmedabad batchmate", lastSpoke: "2026-03-03",
    career: [{ org: "Maruti Suzuki", role: "Manager, Powertrain", from: 2012, to: 2020 }, { org: "EV start-up", role: "Founder", from: 2022 }],
    education: [{ school: "IIM Ahmedabad", degree: "MBA", from: 2020, to: 2022 }],
    expertise: ["autos", "ev", "powertrain"], knows: ["priya"],
  },
  {
    id: "zoya", name: "Zoya Mirza", headline: "Head of Sourcing, Polycab (Copper)", city: "Mumbai", tie: "acquaintance",
    howMet: "Commodities conference, 2025", lastSpoke: "2025-08-19",
    career: [{ org: "Tata Steel", role: "Procurement Manager", from: 2011, to: 2017 }, { org: "Polycab India", role: "Head of Sourcing, Copper & Aluminium", from: 2017 }],
    education: [{ school: "IIT Kharagpur", degree: "B.Tech Metallurgy", from: 2007, to: 2011 }],
    expertise: ["cables", "copper", "commodities", "electricals"], knows: ["aditi"],
  },
];

// Two more contacts whose pasts overlap people who actually appear in recent filings
// (by school / by former employer as stated in the filing) — the "you know someone who knows them" case.
CONTACTS.push(
  {
    id: "rhea", name: "Rhea Kapur", headline: "Principal, consumer-tech VC fund", city: "Mumbai", tie: "friend",
    howMet: "Met through IIM-A alumni network, 2023", lastSpoke: "2026-01-18",
    career: [{ org: "Samsung", role: "Product Marketing", from: 2013, to: 2016 }, { org: "Consumer-tech VC fund", role: "Principal", from: 2019 }],
    education: [{ school: "London Business School", degree: "MBA", from: 2017, to: 2019 }],
    expertise: ["consumer", "electronics manufacturing", "venture"], knows: ["rahul"],
  },
  {
    id: "aman", name: "Aman Verma", headline: "Ex-Tata Motors strategy; now auto-sector consultant", city: "Pune", tie: "professional",
    howMet: "Auto Expo 2025", lastSpoke: "2025-04-09",
    career: [{ org: "Tata Motors", role: "Manager, Corporate Strategy", from: 2009, to: 2018 }, { org: "Independent", role: "Auto-sector consultant", from: 2018 }],
    education: [{ school: "IIT Delhi", degree: "B.Tech Mechanical", from: 2005, to: 2009 }],
    expertise: ["autos", "ev", "tata group"], knows: ["gautam"],
  },
);

export function contactById(id: string) {
  return CONTACTS.find((c) => c.id === id);
}
