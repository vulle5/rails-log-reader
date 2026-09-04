require "test_helper"

class AuthorTest < ActiveSupport::TestCase
  test "an author owns their posts and their comments" do
    assert_equal [ posts(:analytical_engine) ], authors(:ada).posts.to_a
    assert_equal [ comments(:note_g_reply) ], authors(:ada).comments.to_a
  end

  test "destroying an author takes their posts and their comments with them" do
    # Grace wrote two posts and left one comment, on someone else's post.
    assert_difference -> { Post.count }, -2 do
      assert_difference -> { Comment.count }, -1 do
        authors(:grace).destroy!
      end
    end
  end

  test "two authors cannot share an email address" do
    assert_not Author.new(name: "Ada Byron", email: authors(:ada).email).valid?
  end
end
