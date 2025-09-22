extends Node

signal game_won
signal game_lost

var current_flicks = 3
var max_flicks = 3
var game_ended = false
var last_flick_time = 0.0

func _ready():
	process_mode = Node.PROCESS_MODE_ALWAYS

func start_new_game():
	current_flicks = max_flicks
	game_ended = false
	last_flick_time = 0.0
	get_tree().change_scene_to_file("res://scenes/Game.tscn")

func go_to_main_menu():
	get_tree().change_scene_to_file("res://scenes/Main.tscn")

func use_flick():
	current_flicks -= 1
	last_flick_time = Time.get_ticks_msec() / 1000.0

func win_game():
	if not game_ended:
		game_ended = true
		game_won.emit()

func restart_level():
	start_new_game()

func should_check_game_end() -> bool:
	if current_flicks > 0 or game_ended:
		return false
	
	var current_time = Time.get_ticks_msec() / 1000.0
	return (current_time - last_flick_time) >= 0.5

func check_game_end(cart_velocity: float):
	if should_check_game_end() and cart_velocity < 0.1:
		if not game_ended:
			game_ended = true
			game_lost.emit()
