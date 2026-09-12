# The two Scenarios that are not an HTTP request at all: a `rake` task is a Run of its own
# — its own run_id, its own pid, its own seq starting at 1 — and the Sidecar is one shared
# file every opted-in process appends to, so a `rake` task and the server interleave in it
# rather than getting a slab each. Neither task takes an argument or prints anything worth
# reading; what they are for is what lands in the Sidecar while they run, not their own
# output.
namespace :scenarios do
  # Scenario 8 — a rake-task burst: bulk unattributed queries (no request is running this
  # task, so every one of them is homeless — a Run's queries rather than a request's) from a
  # second concurrent Run sharing the Sidecar with whatever server is running beside it. The
  # primary volume Scenario, and the only one that presses on ADR-0003's O_APPEND claim: run
  # it while curling the server and nothing here should ever corrupt a line the other
  # process wrote.
  desc "Scenario 8: a rake-task burst of bulk unattributed queries"
  task rake_burst: :environment do
    2_000.times { Post.count }
  end

  # Scenario 14 — a long-lived rake task that outlives a server restart. It has nothing to
  # do beyond existing across one: a Run that keeps its own run_id and its own climbing seq
  # for as long as it runs, indifferent to however many times the server beside it starts
  # and stops in the meantime. Runs until you stop it — Ctrl-C, or `kill` it by pid — the
  # same shape as Scenario 4's hang, and for the same reason: a bounded loop would just be a
  # slower rake_burst.
  desc "Scenario 14: a long-lived rake task that outlives a server restart"
  task long_task: :environment do
    loop do
      Post.count
      sleep 1
    end
  end
end
