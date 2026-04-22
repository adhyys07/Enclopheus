import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME;

async function testAirtableConnection() {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}?maxRecords=1`;
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      },
    });
    if (!response.ok) {
      const body = await response.text();
      console.error(`Airtable API error ${response.status}: ${body}`);
      return;
    }
    const data = await response.json();
    console.log("Airtable connection successful. Sample record:", data.records[0] || "No records found.");
  } catch (err) {
    console.error("Airtable fetch failed:", err.message);
  }
}

testAirtableConnection();
