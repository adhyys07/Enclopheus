const app = document.getElementById("app");

let activeConversation = null;


function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => e[k] = v);
  children.forEach(c =>
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c)
  );
  return e;
}


async function loadConversations() {
  const res = await fetch("/api/conversations");
  if (res.status === 401) {
    location.href = "/login.html";
    return;
  }

  const convos = await res.json();
  render(convos);
}


async function loadMessages(convoId) {
  activeConversation = convoId;
  const res = await fetch(`/api/messages/${convoId}`);
  const msgs = await res.json();
  renderMessages(msgs);
}


async function sendReply(text) {
  if (!activeConversation || !text) return;

  await fetch("/api/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationId: activeConversation,
      text,
    }),
  });

  loadMessages(activeConversation);
}


function render(convos) {
  app.innerHTML = "";

  const sidebar = el("div", {
    style: `
      width: 300px;
      border-right: 1px solid #ddd;
      padding: 10px;
      height: 100vh;
      overflow-y: auto;
    `
  });

  convos.forEach(c => {
    sidebar.appendChild(
      el("div", {
        onclick: () => loadMessages(c.id),
        style: `
          padding: 8px;
          cursor: pointer;
          border-bottom: 1px solid #eee;
        `
      }, [`User: ${c.slack_user_id}`])
    );
  });

  const main = el("div", {
    style: "flex: 1; padding: 10px;"
  });

  app.appendChild(
    el("div", { style: "display: flex;" }, [sidebar, main])
  );
}

function renderMessages(msgs) {
  const main = app.querySelector("div > div:last-child");
  main.innerHTML = "";

  msgs.forEach(m => {
    main.appendChild(
      el("p", {}, [`${m.sender}: ${m.content}`])
    );
  });

  const input = el("input", {
    placeholder: "Type reply and press Enter",
    style: "width: 100%; padding: 10px; margin-top: 10px;",
    onkeydown: e => {
      if (e.key === "Enter") {
        sendReply(e.target.value);
        e.target.value = "";
      }
    }
  });

  main.appendChild(input);
}


loadConversations();
