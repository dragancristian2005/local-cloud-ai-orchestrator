# Setup tutorial: PC and Mac, step by step

This walks you from nothing to a working `orch` on two machines:

- the **PC** (Windows, with the GPU) runs Ollama and nothing else;
- the **Mac** runs `orch`, your repositories and the `claude` CLI.

Each step is one action, followed by what you should see when it worked. Do Part 1 on the PC, then
Parts 2 and 3 on the Mac. Allow about 30 minutes, most of it the model download.

> **Not yet verified on real hardware**
>
> This tutorial was written in a cloud container with no PC and no GPU. The Mac-side commands were
> run there against a stand-in for Ollama. The steps below were written from Ollama's documentation
> and have not been run on your machines yet. When you have followed one and it worked, delete its
> line; delete this box when the list is empty.
>
> - Part 1, steps 1–8 (everything on the PC)
> - Part 2, step 1: the `claude` sign-in check and the API-key check
> - Part 2, step 5: the connection test from the Mac to the real PC
> - Part 3, steps 1–4 against a real model (they were run against a stand-in)
> - Part 3, step 5: the chat, with a real model that supports tool calling, and its first real
>   hand-over to Claude with read-only tools

---

## Part 1 — PC: the Ollama server

### 1. Install Ollama

Download the Windows installer from <https://ollama.com/download> and run it. It needs Windows 10
22H2 or newer and, for an NVIDIA card, driver 551.61 or newer. It does not need Administrator
rights. After the install Ollama runs in the background and starts when you log in.

Open **PowerShell** and check:

```powershell
ollama --version
```

You should see a version number.

### 2. Download a model and try it

```powershell
ollama pull qwen2.5-coder:7b
ollama run qwen2.5-coder:7b "Say hi in five words."
```

The download is about 5 GB. The second command prints a short answer. Then check that the model
sits on the graphics card:

```powershell
ollama ps
```

The `PROCESSOR` column should say `100% GPU`. If it shows a CPU/GPU split, the model does not fit
in the card's 8 GB and will be slow: choose a smaller model.

### 3. Make Ollama listen on your home network

Out of the box Ollama only answers on the PC itself (`127.0.0.1`). To let the Mac reach it:

1. Quit Ollama: click its icon in the task bar and choose **Quit**.
2. Open **Settings** and search for **environment variables**.
3. Click **Edit environment variables for your account**.
4. Under *User variables* click **New**. Name: `OLLAMA_HOST`. Value: `0.0.0.0:11434`.
5. Click **OK** to save.
6. Start **Ollama** again from the Start menu.

The variable is only read when Ollama starts, so step 6 matters.

### 4. Open the firewall for your private network only

Windows may already have asked "Allow Ollama on private networks?" when it restarted. If you
clicked **Allow**, skip to step 5. Otherwise open **PowerShell as Administrator** and run:

```powershell
New-NetFirewallRule -DisplayName "Ollama (home network)" -Direction Inbound -Protocol TCP -LocalPort 11434 -Action Allow -Profile Private
```

`-Profile Private` is the important part: the port is open on networks you marked as private (your
home), and stays closed on public ones (a café). Check that your home network is marked private:
**Settings > Network & internet >** your connection **> Network profile type > Private network**.

### 5. Find the PC's address and test it

```powershell
ipconfig
```

Note the **IPv4 Address** of your Wi-Fi or Ethernet adapter, for example `192.168.1.50`. Then, still
on the PC:

```powershell
curl.exe http://192.168.1.50:11434/api/tags
```

(with your own address). You should get JSON that lists `qwen2.5-coder:7b`. If this works with
`localhost` but not with the address, `OLLAMA_HOST` was not picked up: repeat step 3.

Tip: give the PC a fixed address in your router's DHCP settings, so it does not change.

### 6. Optional: Tailscale

Tailscale lets the Mac reach the PC by name, and from outside your home, without opening anything
to the internet. Install it on both machines from <https://tailscale.com/download>, sign in to the
same account on both, and use the PC's Tailscale name instead of the address: `http://my-pc:11434`.

### 7. Never expose Ollama to the internet

> **Do not** forward port 11434 on your router, and **do not** allow it on the Public firewall
> profile. Ollama has no password. Anyone who can reach the port can use your GPU and read your
> prompts. LAN and Tailscale only.

### 8. Sleep

Nothing breaks when the PC sleeps or is off. `orch` waits 3 seconds, logs the attempt as
`pc_unreachable` and moves on to Claude. If you would rather keep the local tier available, turn
sleep off while plugged in: **Settings > System > Power > Screen and sleep**.

After a pause the first request is slow: Ollama unloads a model after 5 minutes without use and
needs some seconds to load it again.

---

## Part 2 — Mac: the orchestrator

### 1. Check the requirements

```sh
node --version     # v22.18.0 or newer
git --version
claude --version
```

If Node is older, install the current version from <https://nodejs.org>. Then check that `claude`
is signed in with your subscription:

```sh
claude -p "Say hi in five words."
```

It should print a short answer. If it asks you to log in, run `claude` once and follow `/login`.

Last, make sure no API key is exported in your shell, because `claude -p` would bill that key
instead of using your subscription:

```sh
env | grep -E '^(ANTHROPIC_|CLAUDE_CODE_USE_)' | cut -d= -f1
```

This should print nothing. If it prints `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_BASE_URL` or a `CLAUDE_CODE_USE_...` name, remove that line from your shell profile.
`orch` refuses to use the Claude tier while one of them is set.

### 2. Get the code and run the tests

```sh
git clone https://github.com/dragancristian2005/local-cloud-ai-orchestrator.git
cd local-cloud-ai-orchestrator
npm install
npm test
```

The last lines should show `# fail 0`. The tests use a fake Ollama and a fake `claude`, so they
pass with the PC off.

### 3. Put `orch` on your PATH

```sh
npm link
orch --help
```

You should see `usage: orch <command> [options]`. (Without `npm link`, `npm run orch -- --help`
does the same from inside the project folder.)

### 4. Tell it where the PC is

Create `config/orchestrator.local.json` with your PC's address from Part 1, step 5:

```json
{
  "backends": {
    "pc-ollama": { "baseUrl": "http://192.168.1.50:11434", "model": "qwen2.5-coder:7b" }
  }
}
```

This file is ignored by git. It is merged over `config/orchestrator.config.json`, so it only needs
the values that differ.

### 5. Test the connection from the Mac

```sh
curl http://192.168.1.50:11434/api/tags
```

You should get the same JSON as on the PC. If the command hangs or is refused, see
[Troubleshooting](#part-4--troubleshooting).

---

## Part 3 — First runs

### 1. A commit message

In any repository with a change:

```sh
git add -p
orch run --type commit-message --repo .
```

On stderr you see one line per attempt, then the message on stdout:

```
tier 0 pc-ollama (qwen2.5-coder:7b): pass (1.4s)
Add retry to the fetch helper
```

Each attempt is also a line in the log. From the orchestrator's folder:

```sh
tail -n 1 runs/log.jsonl
```

Because only the message goes to stdout, this works too:

```sh
orch run --type commit-message --repo . | git commit -F -
```

### 2. A documentation comment and a test file

```sh
orch run --type docstring --file src/math.ts --symbol clamp
orch run --type test-stub --file src/math.ts --symbol clamp > src/math.test.ts
```

`--file` is relative to `--repo` (the current folder by default). `orch` prints the result and
never changes your files; the `>` above is you saving it.

### 3. Watch it escalate

Put the PC to sleep and repeat step 1:

```
tier 0 pc-ollama (qwen2.5-coder:7b): pc_unreachable: ollama:qwen2.5-coder:7b is not reachable -> escalate
tier 1 claude (...): pass (6.2s)
Add retry to the fetch helper
```

The first line appears after about 3 seconds. The message now comes from Claude.

### 4. Compare a second model

Pick a second model that fits in 8 GB from <https://ollama.com/library> and copy its exact tag
from that page (written `<second-model>` below). On the PC:

```powershell
ollama pull <second-model>
```

On the Mac:

```sh
orch eval --backend pc-ollama
orch eval --backend pc-ollama --model <second-model>
orch report --mode eval
```

Each `eval` runs the 12 fixed tasks once, with no retry, and prints which passed. `report` then
shows one row per model:

```
backend    model             attempts  pass %  escalated %  avg s  pc down
pc-ollama  <second-model>          12      83            -    2.1        0
pc-ollama  qwen2.5-coder:7b        12      67            -    1.4        0
```

(Your numbers will differ.) `orch eval --backend claude` is refused on purpose: no bulk runs
against the subscription.

### 5. Chat with it

The chat needs a local model that supports tool calling. Ollama's examples use `qwen3`; pick a size
that fits in 8 GB from <https://ollama.com/library> and pull it on the PC (`<tool-model>` below).
Then, on the Mac, point `orch` at it in `config/orchestrator.local.json`:

```json
{
  "backends": {
    "pc-ollama": { "baseUrl": "http://192.168.1.50:11434", "model": "<tool-model>" }
  }
}
```

Go to any project and type `orch`:

```
$ cd ~/dev/my-project
$ orch
orch chat in /Users/you/dev/my-project
local model: <tool-model>; harder requests go to Claude (read-only)
Type /help for commands, /exit to leave.
>
```

Try these four, in order:

1. **A question about the code**, for example `what does this project do?` You should see lines
   such as `[list_dir]` and `[read_file README.md]`, then an answer starting with `local>`.
2. **Something that needs a command**, for example `what were the last three commits?` `git log`
   is on the allow-list, so it runs without asking: `[run] git log --oneline -3 -> exit 0`.
   Then try `run the tests`: you are asked `Run this command? npm test  [y]es / [n]o / [a]lways:`.
3. **A request to change code**, for example `rename the helper in src/util.ts to formatDate`.
   You should see `(to claude: the request needs more than the local model)` and an answer
   starting with `claude>` that contains a diff. Nothing in your files changes.
4. **`/claude`** after any local answer: Claude answers the same message again.

Type `/exit` to leave. Afterwards, from the orchestrator's folder:

```sh
orch report --mode chat
```

shows how many turns the local model kept (`pass %`) and how many it handed over
(`escalated %`). If nearly everything is handed over, or nothing ever is, the model is not
following the triage: try another one.

---

## Part 4 — Troubleshooting

| What you see | Likely cause | Fix |
|---|---|---|
| `pc_unreachable` although the PC is on | `OLLAMA_HOST` not applied, firewall, or wrong address | On the PC, `curl.exe http://<address>:11434/api/tags`. If only `localhost` works, redo Part 1 step 3 and restart Ollama. If the PC works but the Mac does not, redo step 4 and check the network is *Private*. |
| `backend_error ... HTTP 404 for model ...` | The model is not downloaded on the PC | `ollama pull <model>` on the PC, or fix `model` in `config/orchestrator.local.json`. |
| `backend "pc-ollama" still has the placeholder address PC_ADDRESS` | `config/orchestrator.local.json` is missing or has no `baseUrl` | Create it as in Part 2, step 4. |
| `backend_error: ... prompt was truncated by Ollama` | The prompt did not fit the model's context window | Stage fewer generated files (lockfiles), or lower `promptTokenBudget` in the config. |
| `backend_error: ANTHROPIC_API_KEY is set in your environment` | An API key or gateway variable is exported in your shell | Remove it from your shell profile (Part 2, step 1). `orch` will not bill an API key. |
| The first call after a break takes 10–30 s | Ollama unloaded the model after 5 minutes | Nothing to fix. To keep it loaded longer, set the `OLLAMA_KEEP_ALIVE` variable on the PC (for example `1h`) the same way as `OLLAMA_HOST`. |
| `timeout` on every call | The model does not fit in 8 GB of VRAM and runs partly on the CPU | `ollama ps` on the PC: anything but `100% GPU` means too big. Use a smaller model. |
| `verify fail` again and again | The model's answers break the task's rules | Read the reason in the stderr line; look at the raw answer in `runs/<run id>/`. Try another model with `--model`. |
| Claude tier: `backend_error` | `claude` is not signed in, or a flag changed in a newer version | Run `claude -p "hi"` by hand. Then compare `claude --help` with `docs/claude-cli-flags.md`. |
| Chat: `... does not support tool calling` | The local model cannot use tools | Pull a model with tool support and set it in `config/orchestrator.local.json`. Until then every message goes to Claude. |
| Chat: everything goes to Claude, or nothing does | The model does not follow the one-word triage | Try another model. `orch report --mode chat` shows the share. `/claude` always works. |
| Chat: `[refused] ...` | The command is on the refuse-list (destructive, or it names a secrets file) | Run it yourself in another terminal if you really mean it. |
| Chat: `refusing to chat in ... your home directory` | `orch` was started outside a project | `cd` into a project folder first. |
| `orch: command not found` | `npm link` was not run | Run `npm link` in the project folder, or use `npm run orch -- <args>`. |
| `nothing staged` | No staged changes for a commit message | `git add` something first. |
