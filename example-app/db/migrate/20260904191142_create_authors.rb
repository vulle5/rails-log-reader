class CreateAuthors < ActiveRecord::Migration[8.1]
  def change
    create_table :authors do |t|
      t.string :name, null: false
      t.string :email, null: false
      t.text :bio

      t.timestamps
    end

    add_index :authors, :email, unique: true
  end
end
