require "fileutils"
require "json"
require "securerandom"
require "socket"
require "tmpdir"

# Boots the Example app as a real development Run and hands back what a developer would
# look at afterwards: the Sidecar, `log/development.log`, and whatever the Run printed.
#
# It has to be a subprocess. The Initializer refuses every environment but `development`,
# and this suite runs in `test`, so there is no way to reach the Rails half from inside the
# process running the assertions.
#
# The Run happens in a throwaway Rails root: `config/` is copied, so each Run can be shaped
# — the Initializer installed or not, the Marker file present or not, an older Rails faked,
# a Sidecar pre-filled past its cap — and everything large is symlinked. Nothing here writes
# into this app's own `log/` or `config/`, so the tests stay parallel-safe and a crashed one
# leaves no mess.
#
# The Initializer under test is this app's *copy*, not the master at
# `reader/rails/rails_log_reader.rb`, because the copy is what a developer installs. CI is
# what holds the two together.
class DevelopmentRun
  EXAMPLE_APP = File.expand_path("../..", __dir__)

  # Large, and identical for every Run. `bin/` is deliberately absent: `bin/rails` reaches
  # its boot file with `require_relative`, which resolves symlinks, so a symlinked `bin/`
  # would boot the real app root instead of this one. `Rakefile` is absent for the same
  # reason and gets the same fix as `config.ru` below: copied, not symlinked.
  SYMLINKED = %w[app db lib public storage vendor Gemfile Gemfile.lock].freeze

  # How the Run is started. `:environment` is the plainest boot there is. `:config_ru` is the
  # rack entry point a server comes in through — both `rails s` and puma-dev, which is how
  # the app this was written for actually runs. `:rake` boots nothing itself: the script is
  # trusted to do what `bin/rake` does, and has to — `Rake.application.top_level_tasks` is
  # what tells the Initializer this Run's `kind` is "rake", and it has to be populated
  # *before* `config/environment` loads, which `:environment`'s own eager require cannot do.
  ENTRY_POINTS = {
    environment: %(require_relative "config/environment"),
    config_ru: %(require "rack"\nRack::Builder.parse_file("config.ru")),
    rake: ""
  }.freeze

  SIDECAR = "log/rails_log_reader.jsonl"
  MARKER = "log/rails_log_reader.enabled"

  Result = Struct.new(:root, :output, :status, :sidecar_bytes, :development_log, keyword_init: true) do
    def sidecar? = !sidecar_bytes.nil?

    def sidecar_size = sidecar_bytes&.bytesize

    # Raw lines, in append order — for assertions about the bytes themselves (the 256 KB
    # line cap) rather than about what they parse into.
    def lines = sidecar_bytes.to_s.each_line.to_a

    # One JSON object per line, in append order — which is the order the Reader reads them in.
    def events = lines.map { |line| JSON.parse(line) }

    def events_of(type) = events.select { |event| event["type"] == type }

    # The boot warnings, which are the only thing the Initializer ever adds to
    # log/development.log — and which every refusal is supposed to emit exactly one of.
    def warnings = development_log.lines.grep(/rails_log_reader/)

    def booted? = status.success?
  end

  # A Run started in the background rather than waited on — the shape a test needs in order
  # to act on a Run while it is still alive: send it a signal (#31's Scenario 10), or start a
  # second Run beside it in the same root before the first is done (#31's Scenarios 8 and 14).
  # `finish` hands back the same `Result` a blocking `boot` would, once the caller has
  # collected the exit status itself — `Process.wait2`, or a signal handler's own.
  Spawned = Struct.new(:root, :pid, :output_path, keyword_init: true) do
    def finish(status) = DevelopmentRun.result_for(root:, output_path:, status:)
  end

  # A real Puma, listening on a real port. Scenario 10's TERM case turns on Puma's own
  # `force_shutdown_after`, and Scenario 12 turns on Puma's own clustering — neither is
  # anything `spawn`'s bare `ruby run.rb` ever invokes, so this shells out to `puma` itself.
  Served = Struct.new(:root, :pid, :port, :output_path, keyword_init: true) do
    def finish(status) = DevelopmentRun.result_for(root:, output_path:, status:)
  end

  class << self
    # `script` is Ruby evaluated after boot, in the booted Run. The block, if given, gets the
    # root before the Run starts, for tests that need to shape it further.
    def boot(script: "", initializer: true, marker: true, env: "development", through: :environment)
      shared_root(initializer:, marker:) do |root|
        yield root if block_given?
        spawned = spawn(root:, script:, env:, through:)
        _, status = Process.wait2(spawned.pid)
        spawned.finish(status)
      end
    end

    # A throwaway root, built once and handed to the block, for a Scenario that needs more
    # than one Run appending to one Sidecar rather than the one `boot` gives every call of
    # its own. Built and torn down exactly as `boot`'s always was.
    def shared_root(initializer: true, marker: true)
      Dir.mktmpdir("rails-log-reader") do |root|
        build(root, initializer:, marker:)
        # Resolved, because Rails.root is: on macOS the temp dir sits under /var, which is a
        # symlink to /private/var, and a Run only ever knows itself by the latter.
        yield File.realpath(root)
      ensure
        # A test may have made `log/` unwritable; the temp root still has to be removable.
        FileUtils.chmod_R("u+rwX", root, force: true)
      end
    end

    # Starts a Run and returns immediately, without waiting for it to exit — what `boot`
    # itself is built on, plus an immediate wait. Each call gets its own `run.rb` and its own
    # output file, named apart, so two calls sharing one `root` never collide mid-boot.
    def spawn(root:, script: "", env: "development", through: :environment)
      id = SecureRandom.hex(4)
      run_path = File.join(root, "run-#{id}.rb")
      output_path = File.join(root, "output-#{id}.log")
      File.write(run_path, "#{ENTRY_POINTS.fetch(through)}\n#{script}\n")

      pid = Bundler.with_unbundled_env do
        Process.spawn(
          base_env(root:, env:), RbConfig.ruby, run_path, chdir: root, out: output_path, err: output_path
        )
      end

      Spawned.new(root:, pid:, output_path:)
    end

    # A real Puma server, booted from the root's own config/puma.rb on an ephemeral port and
    # confirmed listening before this returns. The caller owns its lifetime from here —
    # signal it, curl it, wait on it — the same as a developer's own terminal would.
    def serve(root:, env: "development", web_concurrency: 0)
      port = free_port
      output_path = File.join(root, "puma-#{port}.log")
      env_vars = base_env(root:, env:).merge("WEB_CONCURRENCY" => web_concurrency.to_s, "PORT" => port.to_s)

      pid = Bundler.with_unbundled_env do
        Process.spawn(env_vars, "bundle", "exec", "puma", "-C", "config/puma.rb",
          chdir: root, out: output_path, err: output_path)
      end

      wait_for_port(port)
      Served.new(root:, pid:, port:, output_path:)
    end

    # The one real HTTP request the request-event tests drive: an in-process Integration
    # session against the app the Run just booted, so a test exercises the actual middleware
    # and subscriber stack rather than calling RailsLogReader.emit as its own front door.
    # `host!` sidesteps ActionDispatch::HostAuthorization, which blocks the Integration
    # session's default host otherwise.
    def real_request(path, params: {}, headers: {})
      <<~RUBY
        session = ActionDispatch::Integration::Session.new(Rails.application)
        session.host! "localhost"
        session.get(#{path.inspect}, params: #{params.inspect}, headers: #{headers.inspect})
      RUBY
    end

    # What `boot`, `Spawned#finish` and `Served#finish` all hand back: the Sidecar and
    # `log/development.log` a root ended up with, whatever wrote them and however many Runs
    # they hold — a shared root's file is one Sidecar same as a throwaway one's.
    def result_for(root:, output_path:, status:)
      Result.new(root:, output: read(output_path).to_s, status:,
        sidecar_bytes: read(File.join(root, SIDECAR)),
        development_log: read(File.join(root, "log/development.log")).to_s)
    end

    private
      def build(root, initializer:, marker:)
        SYMLINKED.each { |entry| File.symlink(File.join(EXAMPLE_APP, entry), File.join(root, entry)) }

        # Copied rather than symlinked, all three, because `require_relative` resolves
        # symlinks: reached through one, config.ru, config/ and the Rakefile would boot the
        # real app root instead of this one.
        FileUtils.cp_r(File.join(EXAMPLE_APP, "config"), File.join(root, "config"))
        FileUtils.cp(File.join(EXAMPLE_APP, "config.ru"), File.join(root, "config.ru"))
        FileUtils.cp(File.join(EXAMPLE_APP, "Rakefile"), File.join(root, "Rakefile"))
        FileUtils.rm_f(File.join(root, "config/initializers/rails_log_reader.rb")) unless initializer

        FileUtils.mkdir_p(File.join(root, "log"))
        FileUtils.mkdir_p(File.join(root, "tmp"))
        # Shared, so every Run gets a warm bootsnap cache and boots in about a second.
        File.symlink(File.join(EXAMPLE_APP, "tmp/cache"), File.join(root, "tmp/cache"))

        FileUtils.touch(File.join(root, MARKER)) if marker
      end

      # What every subprocess this file starts needs regardless of how it is started.
      # SECRET_KEY_BASE_DUMMY is what lets a Run boot in `production` without credentials,
      # which is how the environments this refuses get driven at all.
      def base_env(root:, env:)
        { "RAILS_ENV" => env, "BUNDLE_GEMFILE" => File.join(root, "Gemfile"), "SECRET_KEY_BASE_DUMMY" => "1" }
      end

      def free_port
        TCPServer.open("127.0.0.1", 0) { |server| server.addr[1] }
      end

      def wait_for_port(port, timeout: 20)
        deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
        begin
          TCPSocket.new("127.0.0.1", port).close
        rescue Errno::ECONNREFUSED, Errno::EADDRNOTAVAIL, Errno::ECONNRESET
          raise "puma never opened port #{port}" if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline

          sleep 0.1
          retry
        end
      end

      def read(path) = File.exist?(path) ? File.binread(path) : nil
  end
end
