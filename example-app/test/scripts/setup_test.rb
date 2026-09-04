require "test_helper"
require "open3"
require "tmpdir"

class SetupTest < ActiveSupport::TestCase
  # `bin/setup` is shell rather than the Ruby script `rails new` generates, precisely so it
  # can answer this case: a contributor who has cloned the repo and has no Ruby at all.
  test "bin/setup names the one command that gets Ruby, and installs nothing itself" do
    output, status = run_setup_with_no_ruby_on_the_path

    assert_not status.success?, "bin/setup carried on without Ruby:\n#{output}"
    assert_includes output, "mise use ruby@3.4"
  end

  test "bin/setup names the same command when the Ruby on the PATH is the wrong one" do
    output, status = run_setup_with_ruby_version("3.1.4")

    assert_not status.success?, "bin/setup carried on with the wrong Ruby:\n#{output}"
    assert_includes output, "mise use ruby@3.4"
  end

  # The failure the message existed to prevent and then walked straight into: `mise use`
  # writes a config file, and with mise unhooked from the shell that is *all* it does — so
  # telling someone to run it again is a loop, not an instruction.
  test "bin/setup names the activation step when mise is installed but not hooked into the shell" do
    output, status = run_setup_with_unhooked_mise

    assert_not status.success?
    assert_includes output, "mise activate bash"
    assert_includes output, "~/.bashrc"
  end

  private
    def run_setup_with_no_ruby_on_the_path
      # An absolute bash, because the empty PATH is the whole point of the test. `/bin/bash`
      # is present on both the Linux and macOS this app is developed on.
      Open3.capture2e(
        { "PATH" => "" },
        "/bin/bash", Rails.root.join("bin/setup").to_s,
        unsetenv_others: true
      )
    end

    # A stub `mise` that reports it has a Ruby for this directory, on a PATH holding only
    # it — the shape of a machine where `mise use ruby@3.4` has already been run and the
    # shell hook never has.
    def run_setup_with_unhooked_mise
      Dir.mktmpdir do |bin|
        File.write(File.join(bin, "mise"), "#!/bin/sh\nexit 0\n")
        File.chmod(0o755, File.join(bin, "mise"))

        Open3.capture2e(
          { "PATH" => bin, "SHELL" => "/bin/bash" },
          "/bin/bash", Rails.root.join("bin/setup").to_s,
          unsetenv_others: true
        )
      end
    end

    # A stub `ruby` that answers the version question and nothing else, on a PATH holding
    # only it — so what bin/setup finds is a Ruby of the wrong version, not no Ruby.
    def run_setup_with_ruby_version(version)
      Dir.mktmpdir do |bin|
        File.write(File.join(bin, "ruby"), "#!/bin/sh\nprintf %s #{version}\n")
        File.chmod(0o755, File.join(bin, "ruby"))

        Open3.capture2e(
          { "PATH" => bin },
          "/bin/bash", Rails.root.join("bin/setup").to_s,
          unsetenv_others: true
        )
      end
    end
end
