# radar

A side panel for Claude Code that shows what Claude has loaded (skills, plugins, MCP servers, agents, CLAUDE.md) and what it is using right now (tools, usage history, context).

<!-- Optional: add a screenshot, e.g. ![radar](docs/radar.png) -->

## Usage

Open the panel with `/panel`, optionally followed by a view:

| Command | Shows |
| --- | --- |
| `/panel now` | What Claude is using now: tools, skills, subagents |
| `/panel loaded` | What is loaded: skills, plugins, MCP servers, agents |
| `/panel history` | Usage history |
| `/panel context` | Context usage |

`/panel` alone opens or closes the panel. Inside it, press `1`–`4` or click a tab.

## Install

In a terminal session:

```
/plugin install radar --marketplace CleanCod3Systems/radar
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install radar --marketplace CleanCod3Systems/radar
```

## Early access

The mods API this plugin is built on is early access. It may change between Claude Code versions, and radar may need updates to keep working.

## License

MIT
