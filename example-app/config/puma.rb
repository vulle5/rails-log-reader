# This configuration file will be evaluated by Puma. The top-level methods that are invoked
# here are part of Puma's configuration DSL. For more information about methods provided by
# the DSL, see https://puma.io/puma/Puma/DSL.html.
#
# The Example app is not tuned for throughput. It is tuned to be *worth reading in the
# Reader*, which is a different thing: what matters is that several requests can genuinely
# be in flight at once, so the interleaving the Reader exists to untangle actually happens.

# Fixed rather than sized, and min equal to max, so the pool never ramps up: a burst of
# parallel requests is served in parallel on the first run as well as the tenth. Keep
# `max_connections` in config/database.yml at least this high, or the ninth thread waits on
# a database connection instead of on the database.
threads 8, 8

# One worker means Puma's single mode, so the app is one Run. Setting WEB_CONCURRENCY
# clusters it and each forked worker becomes a Run of its own, with its own pid and its own
# `seq` — the case the Reader has to keep apart. That is an env var, deliberately, so
# trying it is `WEB_CONCURRENCY=2 bin/dev` rather than an edit to this file.
workers Integer(ENV.fetch("WEB_CONCURRENCY", 0))

# Specifies the `port` that Puma will listen on to receive requests; default is 3000.
port ENV.fetch("PORT", 3000)

# Allow puma to be restarted by `bin/rails restart` command.
plugin :tmp_restart

# Specify the PID file. Defaults to tmp/pids/server.pid in development.
# In other environments, only set the PID file if requested.
pidfile ENV["PIDFILE"] if ENV["PIDFILE"]
