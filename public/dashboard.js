const app = document.getElementById("app");

let activeConversation = null;
let conversationsById = new Map();


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
  conversationsById = new Map(convos.map((c) => [String(c.id), c]));
  render(convos);
}


async function loadMessages(convoId) {
  activeConversation = convoId;
  const res = await fetch(`/api/messages/${convoId}`);
  const msgs = await res.json();
  renderMessages(msgs);
}

async function closeConversation() {
  if (!activeConversation) return;
  const res = await fetch(`/api/conversations/${activeConversation}/close`, {
    method: "POST",
  });
  if (!res.ok) {
    alert("Could not close conversation");
    return;
  }
  await loadConversations();
  await loadMessages(activeConversation);
}

async function blockConversation() {
  if (!activeConversation) return;
  const res = await fetch(`/api/conversations/${activeConversation}/block`, {
    method: "POST",
  });
  if (!res.ok) {
    alert("Could not block user");
    return;
  }
  await loadConversations();
  await loadMessages(activeConversation);
}


async function sendReply(text) {
  if (!activeConversation || !text) return;

  const res = await fetch("/api/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationId: activeConversation,
      text,
    }),
  });

  if (!res.ok) {
    alert("Could not send reply. Conversation may be closed/blocked.");
    return;
  }

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
      }, [`#${c.id} | ${c.status.toUpperCase()} | User: ${c.slack_user_id}`])
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
  const current = conversationsById.get(String(activeConversation));
  const isOpen = current && current.status === "open";
  main.innerHTML = "";

  main.appendChild(
    el("h3", {}, [`Conversation #${activeConversation} (${current ? current.status : "unknown"})`])
  );

  msgs.forEach(m => {
    main.appendChild(
      el("p", {}, [`${m.sender}: ${m.content}`])
    );
  });

  const actions = el("div", {
    style: "display: flex; gap: 8px; margin: 12px 0;"
  });

  actions.appendChild(
    el("button", {
      disabled: !isOpen,
      onclick: closeConversation,
      style: "padding: 8px 10px;"
    }, ["Close"])
  );

  actions.appendChild(
    el("button", {
      disabled: !isOpen,
      onclick: blockConversation,
      style: "padding: 8px 10px;"
    }, ["Block User"])
  );

  main.appendChild(actions);

  const input = el("input", {
    placeholder: isOpen ? "Type reply and press Enter" : "Conversation is not open",
    disabled: !isOpen,
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
