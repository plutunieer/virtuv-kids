# Virtuv Kids

A child types a question in a terminal and gets the answer as a colorful, animated page beside it. Any language, any age.

## What you need

- A Mac (an iPad on the same WiFi can use the app, but cannot run it alone)
- [Node.js](https://nodejs.org) 18 or newer
- [Claude Code](https://claude.com/claude-code), installed and logged in

**Everyone needs their own Claude subscription.** The answers are created with the Claude account of the person who runs the app. No API key is used.

## Download and start

1. Download this project: click **Code → Download ZIP** above and unzip it (or `git clone https://github.com/plutunieer/virtuv-kids.git`).
2. Open a terminal in the unzipped folder.
3. Type `npm start` and press Enter.
4. Open **http://localhost:8787** in your browser. An iPad on the same WiFi uses the address on the line starting with `iPad:`.
5. To stop the app, press Ctrl+C in the terminal.

## Good to know

- Parents see all questions at **http://localhost:8787/eltern**.
- In English and German, questions about weapons, violence, sex or drugs are blocked. In other languages, Claude is told to stay child-friendly.
- Questions and answers are stored only in the `data` folder on your computer. To create an answer, the question is sent to Claude.
