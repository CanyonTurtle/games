extends StaticBody3D

@onready var detection_area = $DetectionArea

func _ready():
	detection_area.connect("body_entered", _on_cart_entered)
	detection_area.connect("body_exited", _on_cart_exited)

var cart_inside = false

func _on_cart_entered(body):
	if body.name == "Cart":
		cart_inside = true
		check_win_condition()

func _on_cart_exited(body):
	if body.name == "Cart":
		cart_inside = false

func check_win_condition():
	if cart_inside:
		var cart = get_tree().get_first_node_in_group("cart")
		if cart and cart.linear_velocity.length() < 1.0:
			await get_tree().create_timer(0.5).timeout
			if cart_inside and cart.linear_velocity.length() < 1.0:
				GameManager.win_game()
