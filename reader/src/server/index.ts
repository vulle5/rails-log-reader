import index from "../ui/index.html"
import { RAILS_ROOT_MARKER, findRailsRoot } from "./rails-root"

/** Fixed, so there is nothing to configure and nothing to tell the Reader about. */
const PORT = 5273

const railsRoot = findRailsRoot(process.cwd())

if (railsRoot === null) {
  console.error(
    `rails-log-reader: ${process.cwd()} is not a Rails root.\n` +
      `No ${RAILS_ROOT_MARKER} was found here or in any parent directory. ` +
      `Start the Reader from inside your Rails app.`,
  )
  process.exit(1)
}

const server = Bun.serve({
  port: PORT,
  routes: { "/*": index },
  development: process.env.NODE_ENV === "production" ? false : { hmr: true, console: true },
})

console.log(`Rails log reader  ${server.url}`)
console.log(`Rails root        ${railsRoot}`)
