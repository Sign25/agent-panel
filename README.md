# Agent Panel

A self-hosted web panel for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions on one or several
Linux servers. It is built for daily use from a tablet: every session — started in the panel, in a terminal or through
Remote Control — is a chat you can open, read and write to.

- **Sessions as chats.** Panel chats run Claude Code through the Agent SDK. Terminal and Remote Control sessions are shown
  live; messages typed in the panel go into their tmux pane, questions and permission prompts appear as cards with buttons.
- **Several servers.** One central panel, any number of execution nodes. Connect a VPS from the panel (Servers → Connect a
  server): the panel checks it over SSH, installs a node, starts it and keeps an SSH tunnel to it.
- **Mail between sessions.** Sessions write to each other by address (`host:session`), replies come back to the session
  that asked; a project can name its main session for letters to the whole project.
- **Background work.** Background commands, subagents and monitors of a session are listed in the chat header; a turn waits
  for them instead of killing them. Messages can be added to a running turn.
- **Pictures in answers.** A line `![caption](/absolute/path.png)` in an answer shows the image in the chat.
- Russian and English interface, light and dark themes, browser notifications, Claude plan usage in the header.

## Requirements

- Linux with systemd, root access, a domain name for the panel and [Caddy](https://caddyserver.com/) for HTTPS.
- Node.js 22.13 or newer with npm.
- Claude Code installed and signed in (`claude auth login`) on every server that runs sessions.
- tmux (optional) to type into terminal sessions from the panel.

## Install the central panel

```bash
git clone <this repository> /opt/agent-panel && cd /opt/agent-panel
node password.mjs                     # sets the panel password (stored hashed in data/password.json)
deploy/install.sh panel.example.com main
```

`install.sh` writes `data/config.json` (see `deploy/config.example.json`), installs dependencies, creates the
`agent-panel` systemd service on `127.0.0.1:8787` and adds a Caddy site for the domain. Everything the installation
creates — password, tokens, SSH key, database — lives in `data/` and is never committed.

## Connect more servers

In the panel: **Panel → Servers**.

1. On the new server: Node.js 22.13+, npm and Claude Code (signed in).
2. Run the command the dialog shows: it adds the panel's SSH key to `~/.ssh/authorized_keys` (root).
3. Enter a name and the address, press **Connect**. The panel installs the node into `/opt/agent-panel-node`, creates
   `agent-panel-node.service`, adds two Claude Code hooks for panel mail (existing settings are kept, a copy is saved) and
   starts `panel-<id>-tunnel.service` on the central server. The server appears in the sidebar right away.

**Disconnect** stops the tunnel and forgets the server; the node software stays on it.

## Development

```bash
npm install
npm test        # node --test test/*.test.mjs (uses a fake Claude CLI, no account needed)
```

Code map: `server.mjs` (HTTP API, task runs, mail delivery), `agents/` (agent registry; Claude Code is the default),
`claude-worker.mjs` (one Agent SDK run per turn), `claude-sessions.mjs` (reading session files), `session-wake.mjs`
(tmux: waking sessions, answering their dialogs), `federation.mjs` / `project-mail.mjs` (nodes and mail),
`nodes-admin.mjs` (connecting servers), `public/` (the interface, no build step).

## Security notes

- The panel runs as root and can start Claude Code with any permission mode you choose; protect it with a strong password.
- Nodes are reached only through SSH tunnels to their loopback ports; every node request carries the node's token.
- Mail from other sessions is shown to the model as data from another agent, not as instructions from the owner.

---

## Кратко по-русски

Панель для работы с сессиями Claude Code на нескольких серверах, рассчитанная на планшет. Сессии из панели, терминала и
Remote Control открываются как чаты. Новые VPS подключаются из меню «Панель → Серверы». Сессии переписываются между
собой. Фоновые задачи видны в шапке чата, картинки из ответов показываются в чате. Установка центральной панели — раздел
«Install the central panel» выше; всё, что создаёт установка, хранится в `data/` и в репозиторий не попадает.
