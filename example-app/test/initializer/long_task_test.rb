require "test_helper"
require "support/development_run"

# Scenario 14 (#31): `bin/rake scenarios:long_task`, a long-lived rake task that outlives a
# server restart. The task itself has nothing to prove beyond persisting: one run_id and one
# climbing seq for as long as it runs, indifferent to however many times a server Run beside
# it starts and stops in the same Sidecar — which two throwaway `spawn` boots, standing in
# for "the server restarted", exist here to show.
class LongTaskTest < ActiveSupport::TestCase
  INVOKE_LONG_TASK = <<~RUBY
    require "rake"
    Rails.application.load_tasks
    Rake::Task["scenarios:long_task"].invoke
  RUBY

  test "the long task keeps its own run_id and seq across two Runs that start and stop beside it" do
    DevelopmentRun.shared_root do |root|
      task = DevelopmentRun.spawn(root:, script: INVOKE_LONG_TASK)
      sleep 1.2

      # Two ordinary boot-and-exit Runs, one after another — standing in for the server
      # restarting once while the long task keeps going, sharing the one Sidecar throughout.
      [1, 2].each do
        restart = DevelopmentRun.spawn(root:, script: "")
        _, status = Process.wait2(restart.pid)
        assert status.success?, "a restart Run failing would leave nothing meaningful to interleave with"
        sleep 1.2
      end

      Process.kill("TERM", task.pid)
      _, status = Process.wait2(task.pid)
      result = task.finish(status)

      by_run = result.events.group_by { |event| event["run_id"] }
      assert_equal 3, by_run.size, "the long task plus the two Runs that started and stopped beside it"

      restarts = by_run.reject { |run_id, _| run_id == result.events_of("sql").first["run_id"] }
      restarts.each_value do |events|
        assert_equal %w[run_header run_end], events.map { |event| event["type"] },
          "a restart Run that made no request and ran no query is nothing but its own two ends"
      end

      long_task_run_id = result.events_of("sql").first["run_id"]
      long_task_events = by_run.fetch(long_task_run_id)
      assert_operator long_task_events.count { |event| event["type"] == "sql" }, :>=, 2,
        "it kept running across both restarts, not just once at the start"
      assert_equal [], long_task_events.map { |event| event["request_id"] }.uniq.compact,
        "every query a rake task runs is unattributed — there is no request to own it"
      assert_equal (1..long_task_events.size).to_a, long_task_events.map { |event| event["seq"] }.sort,
        "one continuous seq for the whole task's life, untouched by the restarts around it"

      # The interleaving itself, by append position rather than by seq (which cannot compare
      # across Runs): the second restart's own run_header — the later of the two, in append
      # order — has to land after at least one of the long task's own events, proof the task
      # was still running, into one shared, growing file, when the server came back up
      # rather than everything here being three files concatenated after the fact.
      second_restart_header = result.events_of("run_header").reject { |e| e["run_id"] == long_task_run_id }.last
      before_second_restart = result.events.first(result.events.index(second_restart_header))
      assert before_second_restart.any? { |event| event["run_id"] == long_task_run_id },
        "the long task had already emitted something before the server's second restart began"
    end
  end
end
