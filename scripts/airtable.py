#Migration script to invite users from Airtable to Slack channels with rate limit handling and retries.
import requests
import time
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

# ✅ Fix unicode printing
sys.stdout.reconfigure(encoding='utf-8')

# 🔐 CONFIG
TOKEN = "slack-bot-token"

CHANNELS = [
    "channel_ids"
]

AIRTABLE_API_KEY = "airtable_api_key"
BASE_ID = "baseid"
TABLE_NAME = "users"

# 📥 Airtable fetch
def fetch_all_records():
    url = f"https://api.airtable.com/v0/{BASE_ID}/{TABLE_NAME}"
    headers = {
        "Authorization": f"Bearer {AIRTABLE_API_KEY}"
    }

    records = []

    while url:
        res = requests.get(url, headers=headers).json()
        records.extend(res["records"])

        offset = res.get("offset")
        if offset:
            url = f"https://api.airtable.com/v0/{BASE_ID}/{TABLE_NAME}?offset={offset}"
        else:
            url = None

    return records


# 🚀 Slack invite with retry + rate limit handling
def invite_with_retry(slack_id, channel):
    while True:
        res = requests.post(
            "https://slack.com/api/conversations.invite",
            headers={
                "Authorization": f"Bearer {TOKEN}",
                "Content-Type": "application/json"
            },
            json={
                "channel": channel,
                "users": slack_id
            }
        )

        data = res.json()

        if data.get("ok"):
            print(f"✅ {slack_id} → {channel}")
            return

        error = data.get("error")

        if error == "ratelimited":
            retry_after = int(res.headers.get("Retry-After", 1))
            print(f"⏳ Rate limited → waiting {retry_after}s")
            time.sleep(retry_after)
            continue

        elif error == "already_in_channel":
            print(f"⚠️ {channel}: already_in_channel")
            return

        elif error == "user_is_restricted":
            print(f"⚠️ {channel}: user_is_restricted")
            return

        elif error == "cant_invite":
            print(f"⚠️ {channel}: cant_invite")
            return

        else:
            print(f"❌ {channel}: {error}")
            return


# 🧠 MAIN
records = fetch_all_records()

print(f"Total users fetched: {len(records)}")

for record in records:
    fields = record.get("fields", {})
    slack_id = fields.get("SlackId")

    if not slack_id:
        print("❌ No Slack ID → skip")
        continue

    print(f"\nProcessing {slack_id}")

    for channel in CHANNELS:
        invite_with_retry(slack_id, channel)
        time.sleep(1)  # safe delay (VERY IMPORTANT)

print("\n🎉 Done!")