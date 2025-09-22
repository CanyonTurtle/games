extends Node3D

@onready var ui_label = $UI/FlicksLabel
@onready var game_over_panel = $UI/GameOverPanel
@onready var win_label = $UI/GameOverPanel/WinLabel
@onready var restart_button = $UI/GameOverPanel/RestartButton
@onready var menu_button = $UI/GameOverPanel/MenuButton

func _ready():
	GameManager.connect("game_won", _on_game_won)
	GameManager.connect("game_lost", _on_game_lost)
	restart_button.connect("pressed", _on_restart_pressed)
	menu_button.connect("pressed", _on_menu_pressed)
	
	# Ensure buttons can process when game is paused
	game_over_panel.process_mode = Node.PROCESS_MODE_WHEN_PAUSED
	restart_button.process_mode = Node.PROCESS_MODE_WHEN_PAUSED
	menu_button.process_mode = Node.PROCESS_MODE_WHEN_PAUSED
	
	update_ui()

func _process(delta):
	update_ui()
	check_cart_velocity()

func update_ui():
	ui_label.text = "Flicks: " + str(GameManager.current_flicks)

func check_cart_velocity():
	var cart = get_tree().get_first_node_in_group("cart")
	if cart:
		var velocity = cart.linear_velocity.length()
		GameManager.check_game_end(velocity)

func _on_game_won():
	game_over_panel.visible = true
	win_label.text = "You Win!"
	get_tree().paused = true

func _on_game_lost():
	game_over_panel.visible = true
	win_label.text = "Game Over!"
	get_tree().paused = true

func _on_restart_pressed():
	get_tree().paused = false
	GameManager.restart_level()

func _on_menu_pressed():
	get_tree().paused = false
	GameManager.go_to_main_menu()
