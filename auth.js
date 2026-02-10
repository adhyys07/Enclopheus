import express from "express";
import fetch from "node-fetch";

const router = express.Router();

router.get("/login", (req, res) => {
  const url = `https://slack.com/oauth/v2/authorize?client_id=${process.env.SLACK_CLIENT_ID}&scope=identity.basic&redirect_uri=${process.env.SLACK_REDIRECT_URI}`;
  res.redirect(url);
});

router.get("/callback", async (req, res) => {
    const code = req.query.code;

    const r = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: process.env.SLACK_CLIENT_ID,
            client_secret: process.env.SLACK_CLIENT_SECRET,
            code,
            redirect_uri: process.env.SLACK_REDIRECT_URI,
        }),
    });

    const data = await r.json();
    const slackId = data.authed_user.id;

    const allowed = process.env.OWNERS.split(",");
    if (!allowed.includes(slackId)) {
        return res.status(403).send("Access denied");
    }
    req.session.admin = slackId;
    res.redirect("/dashboard");
});

export default router;