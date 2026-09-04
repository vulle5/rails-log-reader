require "test_helper"

class PostTest < ActiveSupport::TestCase
  test "a post belongs to its author and holds its comments oldest first" do
    post = posts(:analytical_engine)

    assert_equal authors(:ada), post.author
    assert_equal [ "The loop in note G is the part everyone skips.", "It is the only part that matters." ],
      post.comments.map(&:body)
  end

  test "a post without a title is invalid" do
    assert_not Post.new(author: authors(:ada), body: "No title.").valid?
  end

  test "published lists only posts with a publication date, newest first" do
    assert_equal [ posts(:nanoseconds), posts(:analytical_engine) ], Post.published.to_a
  end

  test "destroying a post destroys the comments hanging off it" do
    assert_difference -> { Comment.count }, -2 do
      posts(:analytical_engine).destroy!
    end
  end
end
