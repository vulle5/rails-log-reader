require "fileutils"
require "json"
require "open3"
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
  # would boot the real app root instead of this one.
  SHARED = %w[app db lib public storage vendor Gemfile Gemfile.lock Rakefile].freeze

  SIDECAR = "log/rails_log_reader.jsonl"
  MARKER = "log/rails_log_reader.enabled"

  Result = Struct.new(:root, :output, :status, :sidecar, :development_log, keyword_init: true) do
    def sidecar? = !sidecar.nil?

    def sidecar_size = sidecar&.bytesize

    # One JSON object per line, in append order — which is the order the Reader reads them in.
    def events = sidecar.to_s.each_line.map { |line| JSON.parse(line) }

    def events_of(type) = events.select { |event| event["type"] == type }

    def booted? = status.success?
  end

  # `script` is Ruby evaluated after boot, in the booted Run. The block, if given, gets the
  # root before the Run starts, for tests that need to shape it further.
  def self.boot(script: "", initializer: true, marker: true, env: "development")
    Dir.mktmpdir("rails-log-reader") do |root|
      build(root, initializer:, marker:)
      yield root if block_given?
      File.write(File.join(root, "run.rb"), "require_relative \"config/environment\"\n#{script}\n")

      output, status = run(root, env)

      Result.new(
        root:, output:, status:,
        sidecar: read(File.join(root, SIDECAR)),
        development_log: read(File.join(root, "log/development.log")).to_s
      )
    ensure
      # A test may have made `log/` unwritable; the temp root still has to be removable.
      FileUtils.chmod_R("u+rwX", root, force: true)
    end
  end

  def self.build(root, initializer:, marker:)
    SHARED.each { |entry| File.symlink(File.join(EXAMPLE_APP, entry), File.join(root, entry)) }

    FileUtils.cp_r(File.join(EXAMPLE_APP, "config"), File.join(root, "config"))
    FileUtils.rm_f(File.join(root, "config/initializers/rails_log_reader.rb")) unless initializer

    FileUtils.mkdir_p(File.join(root, "log"))
    FileUtils.mkdir_p(File.join(root, "tmp"))
    # Shared, so every Run gets a warm bootsnap cache and boots in about a second.
    File.symlink(File.join(EXAMPLE_APP, "tmp/cache"), File.join(root, "tmp/cache"))

    FileUtils.touch(File.join(root, MARKER)) if marker
  end

  def self.run(root, env)
    Bundler.with_unbundled_env do
      Open3.capture2e(
        # SECRET_KEY_BASE_DUMMY is what lets a Run boot in `production` without credentials,
        # which is how the environments this refuses outright get driven at all.
        { "RAILS_ENV" => env, "BUNDLE_GEMFILE" => File.join(root, "Gemfile"),
          "SECRET_KEY_BASE_DUMMY" => "1" },
        RbConfig.ruby, "run.rb", chdir: root
      )
    end
  end

  def self.read(path) = File.exist?(path) ? File.binread(path) : nil
  private_class_method :build, :run, :read
end
