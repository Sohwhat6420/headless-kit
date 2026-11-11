## Rename the config file

Rename `config.old.json` to `config.json` and update the one reader.

1. Run `git mv config.old.json config.json`.
2. Edit `src/load.mjs` line 12 to read `config.json`.
3. Run `node src/load.mjs` and check it prints the settings.
