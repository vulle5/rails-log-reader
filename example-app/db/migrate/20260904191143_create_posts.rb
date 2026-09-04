class CreatePosts < ActiveRecord::Migration[8.1]
  def change
    create_table :posts do |t|
      t.string :title, null: false
      t.text :body, null: false
      # Null means a draft, which is why `published` is a scope and not a boolean column.
      t.datetime :published_at
      t.references :author, null: false, foreign_key: true
      # A counter cache, so the index can show a comment count without a query per row —
      # and so a write carries the UPDATE that maintains it.
      t.integer :comments_count, null: false, default: 0

      t.timestamps
    end

    add_index :posts, :published_at
  end
end
