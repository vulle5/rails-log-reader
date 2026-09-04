require "test_helper"
require "open3"

class SetupTest < ActiveSupport::TestCase
  # `bin/setup` is shell rather than the Ruby script `rails new` generates, precisely so it
  # can answer this case: a contributor who has cloned the repo and has no Ruby at all.
  test "bin/setup names the one command that gets Ruby, and installs nothing itself" do
    output, status = run_setup_with_no_ruby_on_the_path

    assert_not status.success?, "bin/setup carried on without Ruby:\n#{output}"
    assert_includes output, "mise use ruby@3.4"
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
end
