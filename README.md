# Rails Log Reader

A web-based reader for Ruby on Rails development logs. It streams what your Rails app is
doing (requests, SQL queries, and `Rails.logger` calls) into a browser UI, grouped by
request, so a request's own queries and log lines show up together instead of scattered
across a scrolling `tail -f development.log`.

Two projects live in this repo:

- **`reader/`**: the Reader itself, a Bun server + React UI. This is the product.
- **`example-app/`**: a small Rails app that exists purely to generate traffic for
  testing the Reader against.

See [`CONTEXT.md`](CONTEXT.md) for the full glossary and design constraints, and
[`docs/adr/`](docs/adr) for why things are built the way they are.

## Quickstart: try it against the Example app

The fastest way to see it working, no setup against a real app needed.

```sh
cd example-app
bin/setup   # installs gems, prepares the SQLite database
bin/dev     # starts the Example app on http://localhost:3000
```

In another terminal:

```sh
cd reader
bun install
bun dev     # http://localhost:5273
```

Click around `http://localhost:3000` (or visit `/scenarios` for canned traffic patterns:
parallel requests, an N+1, a slow query, a hang) and watch it show up in the Reader at
`http://localhost:5273`.

## Using it against your own Rails app

The Reader works against any Rails 7.1+ app, with one file added: no gem, no bundler
entry.

1. **Copy the Initializer** into your app:

   ```sh
   cp reader/rails/rails_log_reader.rb ~/path/to/your-app/config/initializers/
   ```

   It does nothing until you opt in (step 2), so this is safe to commit and share with a
   team: a colleague who never enables it sees no difference at all.

2. **Turn it on** for yourself:

   ```sh
   cd ~/path/to/your-app
   touch log/rails_log_reader.enabled
   ```

3. **Restart your Rails app** (`rails s`, a puma-dev reload, etc.). The marker file is
   only read at boot.

4. **Start the Reader from inside your app's directory.** It auto-detects the Rails root
   from wherever it's run: there's no config file and no `--path` flag.

   ```sh
   cd ~/path/to/your-app
   bun /path/to/rails-log-reader/reader/src/server/index.ts
   ```

5. Open **http://localhost:5273** and use your app as normal.

To turn the Reader off again, delete `log/rails_log_reader.enabled` and restart.

### Notes

- Needs [Bun](https://bun.sh) installed. Rails itself needs to be 7.1 or newer. The
  Initializer checks this at boot and disables itself with a warning if it isn't.
- The Reader writes to `log/rails_log_reader.jsonl` in your app and never to
  `development.log`. Check your app's `.gitignore` covers it (and the `.enabled` marker);
  if it doesn't and you'd rather not touch a shared `.gitignore`, add both to your local
  `.git/info/exclude` instead.
- Running two Rails apps at once? Only one Reader can hold port 5273, so set
  `RAILS_LOG_READER_PORT` for the second one.
- The tab title and the header both show your app's name, by default it's the value of
  `Rails.application.class.module_parent_name`. Set `RAILS_LOG_READER_APP_NAME` to override it.

## Checks

```sh
cd reader
bun test
bunx tsc --noEmit
```
