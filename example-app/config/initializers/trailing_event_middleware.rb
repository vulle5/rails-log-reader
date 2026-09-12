# Scenario 13 (#31) — a middleware outside Rails::Rack::Logger, wrapping the response body
# in its own Rack::BodyProxy, logging one line and running one query in the close block.
#
# Defined here rather than under app/middleware: this file runs during
# `Rails::Application#initialize!`, before Zeitwerk's main autoloader is set up, so a
# constant it referenced from app/ would raise the moment this line evaluated it — the same
# reason config/initializers/rails_log_reader.rb defines its own classes inline instead of
# reaching into app/.
#
# `Rack::BodyProxy#close` closes its own wrapped body first and runs its own block after —
# so a proxy built here, around whatever `Rails::Rack::Logger` already wrapped the body in,
# closes *after* Logger's own proxy does. Logger's proxy close is what fires
# `request.action_dispatch`'s finish — the Initializer's `request_finish` — so this
# middleware's own block genuinely runs once that request is already over: a trailing query
# and a trailing log line, not a race against one.
#
# Both still carry that request's own request_id, because `ActionDispatch::Executor` — which
# resets it once the request completes — sits far outside this middleware in the default
# stack (`bin/rails middleware`) and so closes last of all, after this middleware's own block
# has already run.
#
# Scoped to this one Scenario's own path: an ordinary request through this middleware pays
# for one extra method call and nothing else.
class TrailingEventMiddleware
  PATH = "/scenarios/trailing_event"

  def initialize(app) = @app = app

  def call(env)
    status, headers, body = @app.call(env)
    return [status, headers, body] unless env["PATH_INFO"] == PATH

    [status, headers, ::Rack::BodyProxy.new(body) { trail }]
  end

  private
    def trail
      Rails.logger.info("Scenario 13: logged from a close block, after the response finished.")
      Comment.count
    end
end

Rails.application.config.middleware.insert_before Rails::Rack::Logger, TrailingEventMiddleware
