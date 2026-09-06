## 1. Guide authoring

- [ ] 1.1 Author `docs/agent-guide.md` intent-first: the routing table across all five intent classes (relationship → MCP graph tools; exact-string → built-in search/read; status/freshness → `/cgc` commands; management → CLI-gap tools; indexing → automatic gate plus manual overrides), the configuration and consent overview, backend caveats, troubleshooting pointers, and the supported-CGC-version scope line.
- [ ] 1.2 Write the worked end-to-end example session using only implemented surfaces.
- [ ] 1.3 Create the repository README if absent and link the guide from it; reference it from the opt-in routing skill's deep-dive section (link, not copy).

## 2. Accuracy and verification

- [ ] 2.1 Implement the accuracy test: extract surfaces named in the guide (tool names, `/cgc` commands, config keys) and assert each exists in the implemented registries; wire it into CI.
- [ ] 2.2 Verify all scenarios in `specs/cgc-agent-guide/spec.md` against the artifacts.
- [ ] 2.3 Run `openspec validate add-cgc-agent-guide --type change --strict` before archive.
