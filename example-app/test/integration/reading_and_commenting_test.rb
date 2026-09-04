require "test_helper"

class ReadingAndCommentingTest < ActionDispatch::IntegrationTest
  test "the index lists published posts, newest first, and leaves drafts out" do
    get root_path

    assert_response :success
    assert_select "a[href=?]", post_path(posts(:nanoseconds)), text: posts(:nanoseconds).title
    assert_select "a[href=?]", post_path(posts(:analytical_engine)), text: posts(:analytical_engine).title
    assert_select "a[href=?]", post_path(posts(:draft_on_compilers)), count: 0
  end

  test "a post's page shows its body, its author and its comments" do
    get post_path(posts(:analytical_engine))

    assert_response :success
    assert_select "body", text: /Note G is the part everyone skips/
    assert_select "body", text: /Ada Lovelace/
    assert_select "body", text: /The loop in note G is the part everyone skips\./
  end

  # The shape the Reader exists to make readable: a read, a write, a redirect, and the
  # read that follows it — four log entries for what the user experiences as one click.
  test "leaving a comment is GET, POST, redirect, GET, with the write in the middle" do
    get post_path(posts(:analytical_engine))
    assert_response :success
    assert_select "form[action=?][method=?]", post_comments_path(posts(:analytical_engine)), "post"

    assert_difference -> { Comment.count }, 1 do
      post post_comments_path(posts(:analytical_engine)), params: {
        comment: { body: "Reading it now.", author_id: authors(:grace).id }
      }
    end

    assert_redirected_to post_path(posts(:analytical_engine))
    follow_redirect!

    assert_response :success
    assert_select "body", text: /Reading it now\./
  end

  test "a comment with no body writes nothing and re-renders the post" do
    assert_no_difference -> { Comment.count } do
      post post_comments_path(posts(:analytical_engine)), params: {
        comment: { body: "", author_id: authors(:grace).id }
      }
    end

    assert_response 422
    assert_select "body", text: /Note G is the part everyone skips/
  end
end
