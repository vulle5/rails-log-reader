class CommentsController < ApplicationController
  def create
    @post = Post.find(params[:post_id])
    @comment = @post.comments.new(comment_params)

    if @comment.save
      redirect_to @post, notice: "Comment added."
    else
      @comments = @post.comments.includes(:author)
      @authors = Author.order(:name)
      render "posts/show", status: :unprocessable_content
    end
  end

  private
    def comment_params
      params.expect(comment: [ :body, :author_id ])
    end
end
