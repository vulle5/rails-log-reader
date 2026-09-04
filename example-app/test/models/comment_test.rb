require "test_helper"

class CommentTest < ActiveSupport::TestCase
  test "a comment names both the post it is on and the author who left it" do
    comment = comments(:note_g)

    assert_equal posts(:analytical_engine), comment.post
    assert_equal authors(:grace), comment.author
  end

  test "a comment without a body is invalid" do
    assert_not Comment.new(post: posts(:analytical_engine), author: authors(:ada)).valid?
  end
end
