extends Control

@onready var play_button = $PlayButton
@onready var quit_button = $QuitButton

func _ready():
	play_button.connect("pressed", _on_play_pressed)
	quit_button.connect("pressed", _on_quit_pressed)

func _on_play_pressed():
	GameManager.start_new_game()

func _on_quit_pressed():
	get_tree().quit()