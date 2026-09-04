require "test_helper"
require "digest"

# `bin/reset` restores the seed, and it can only restore something if re-running it lands
# on the same rows. That is what these tests hold: the seed is a fixed body of data, not a
# fresh roll of the dice each time.
class SeedsTest < ActiveSupport::TestCase
  test "seeding produces a few hundred rows across the three models" do
    seed!

    assert_equal 12, Author.count
    assert_equal 60, Post.count
    assert_equal 300, Comment.count
  end

  test "seeding twice lands on exactly the same rows" do
    seed!
    once = digest_of_every_row

    seed!

    assert_equal 60, Post.count, "re-seeding appended rows instead of replacing them"
    assert_equal once, digest_of_every_row
  end

  test "the seed is written down, not rolled" do
    seed!

    assert_equal "Ada Lovelace", Author.order(:id).first.name
    assert_equal "Indexing in practice", Post.order(:id).first.title
    assert_equal Time.utc(2026, 1, 1, 9, 0, 0), Post.order(:id).first.published_at
  end

  test "some posts are drafts, so the index has something to leave out" do
    seed!

    assert_equal 6, Post.where(published_at: nil).count
  end

  private
    # Seeds run against the test database inside the test's own transaction, so this leaves
    # the developer's seeded database alone.
    def seed!
      Rails.application.load_seed
    end

    # Every column that carries seed data, keyed by the natural keys rather than the
    # surrogate ids: SQLite's AUTOINCREMENT never reuses a row id, so a second `db:seed`
    # over a live database renumbers. `bin/reset` drops the database first, which is what
    # makes the ids stable too — the rows themselves are stable either way, and that is
    # what determinism has to mean here.
    def digest_of_every_row
      Digest::SHA256.hexdigest([
        Author.order(:email).pluck(:name, :email, :bio),
        Post.joins(:author).order(:created_at)
          .pluck(:title, :body, :published_at, :comments_count, "authors.email"),
        Comment.joins(:post, :author).order(:created_at)
          .pluck(:body, :created_at, "posts.title", "authors.email")
      ].to_json)
    end
end
