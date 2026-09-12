require "test_helper"
require "support/development_run"
require "net/http"

# Scenario 10 (#31): an Interrupted request, twice. Both start the same way — the hang
# Scenario (4) mid-flight — and diverge only in how the process dies. Both need a real,
# listening Puma: SIGKILL bypasses Ruby entirely, and TERM's clean path turns on Puma's own
# `force_shutdown_after` (config/puma.rb), neither of which anything else in this suite
# actually invokes.
class InterruptedTest < ActiveSupport::TestCase
  # A background request against a real server, given a moment to actually reach the
  # controller's own `sleep` before this returns — `served`'s caller kills the process next.
  def hang_against(served)
    Thread.new do
      Net::HTTP.get(URI("http://127.0.0.1:#{served.port}/scenarios/hang"))
    rescue StandardError
      nil # the connection dies with the process; that is the point of this Scenario
    end
    sleep 0.5
  end

  test "SIGKILL leaves the hanging request's Run with no run_end at all" do
    DevelopmentRun.shared_root do |root|
      served = DevelopmentRun.serve(root:)
      hang_against(served)

      Process.kill("KILL", served.pid)
      _, status = Process.wait2(served.pid)
      result = served.finish(status)

      header = result.events_of("run_header").sole
      assert_equal Integer(header["payload"]["pid"]), served.pid

      assert result.events_of("request_start").sole, "the hang got as far as starting"
      assert_empty result.events_of("request_finish"), "the request never finished — that is the hang"
      assert_empty result.events_of("run_end"),
        "no at_exit runs under SIGKILL — this Run's interruption has nothing on the wire " \
        "to say so beyond its own absence, which is exactly what the next Run's header " \
        "has to be read against"
    end
  end

  # Not what it first looks like: `force_shutdown_after` raises inside the sleeping
  # controller thread, but that raise unwinds straight into `ActionDispatch::DebugExceptions`
  # — active on these default development settings — which rescues it same as any other
  # exception and renders the ordinary debug page. The request is not left dangling at all;
  # it finishes, honestly, naming Puma's own exception as the reason. That is the whole of
  # "the clean path": nothing here is inferred or left for the Reader to conclude — not the
  # request (a request_finish that says what happened) and not the Run (an ordinary
  # run_end) — which is the entire contrast with SIGKILL below, where neither exists at all.
  test "TERM with force_shutdown_after is the clean path: the hanging request finishes, naming Puma's own exception, and the Run still ends cleanly" do
    DevelopmentRun.shared_root do |root|
      served = DevelopmentRun.serve(root:)
      hang_against(served)

      started_at = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      Process.kill("TERM", served.pid)
      _, status = Process.wait2(served.pid)
      elapsed = Process.clock_gettime(Process::CLOCK_MONOTONIC) - started_at
      result = served.finish(status)

      assert_operator elapsed, :>, 4,
        "force_shutdown_after 5 (config/puma.rb) is what makes this the slow path rather " \
        "than a plain TERM deadlocked against the hang forever"

      assert result.events_of("request_start").sole, "the hang got as far as starting"

      finish = result.events_of("request_finish").sole
      assert_equal 500, finish["payload"]["status"]
      assert_equal "Puma::ThreadPool::ForceShutdown", finish["payload"]["exception"]["class"],
        "the request finished honestly naming what actually happened to it, rather than " \
        "being left to look like an ordinary hang forever"

      assert result.events_of("run_end").sole,
        "the clean path: force_shutdown_after lets the process exit normally, so at_exit " \
        "still runs and the Reader never has to infer this Run's end from the next one's " \
        "header the way SIGKILL leaves it"
    end
  end
end
