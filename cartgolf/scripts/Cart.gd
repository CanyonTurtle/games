extends RigidBody3D

var is_dragging = false
var drag_start_pos = Vector2.ZERO
var launch_power = 20.0
var max_drag_distance = 200.0

var trajectory_markers = []
var trajectory_material: StandardMaterial3D

func _ready():
	# Make this cart's camera the current camera
	var camera = get_node("CameraMount/Camera3D")
	camera.current = true
	
	# Create trajectory material
	trajectory_material = StandardMaterial3D.new()
	trajectory_material.albedo_color = Color(1, 1, 0, 0.8)  # Yellow with transparency
	trajectory_material.emission_enabled = true
	trajectory_material.emission = Color(1, 1, 0, 1)
	trajectory_material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA

func _input(event):
	if event is InputEventMouseButton:
		if event.button_index == MOUSE_BUTTON_LEFT:
			if event.pressed and GameManager.current_flicks > 0:
				start_drag(event.position)
			elif not event.pressed and is_dragging:
				end_drag(event.position)
	
	elif event is InputEventMouseMotion and is_dragging:
		update_drag(event.position)

func start_drag(pos: Vector2):
	if linear_velocity.length() < 0.5:
		is_dragging = true
		drag_start_pos = pos
		show_trajectory_markers()

func update_drag(pos: Vector2):
	if not is_dragging:
		return
		
	var drag_vector = drag_start_pos - pos
	var drag_distance = drag_vector.length()
	
	if drag_distance > max_drag_distance:
		drag_vector = drag_vector.normalized() * max_drag_distance
	
	update_trajectory_preview(drag_vector)

func end_drag(pos: Vector2):
	if not is_dragging:
		return
		
	is_dragging = false
	hide_trajectory_markers()
	
	var drag_vector = drag_start_pos - pos
	var drag_distance = drag_vector.length()
	
	if drag_distance > 10:
		if drag_distance > max_drag_distance:
			drag_vector = drag_vector.normalized() * max_drag_distance
		
		var force_strength = (drag_distance / max_drag_distance) * launch_power
		var camera = get_viewport().get_camera_3d()
		var force_3d = Vector3(drag_vector.x, 0, drag_vector.y).normalized() * force_strength
		force_3d = camera.global_transform.basis * force_3d
		force_3d.y = 0
		
		apply_central_impulse(force_3d)
		GameManager.use_flick()

func show_trajectory_markers():
	hide_trajectory_markers()  # Clear existing markers
	
	# Create trajectory markers
	for i in range(8):
		var marker = MeshInstance3D.new()
		var sphere_mesh = SphereMesh.new()
		sphere_mesh.radius = 0.1
		sphere_mesh.height = 0.2
		marker.mesh = sphere_mesh
		marker.material_override = trajectory_material
		add_child(marker)
		trajectory_markers.append(marker)

func hide_trajectory_markers():
	for marker in trajectory_markers:
		marker.queue_free()
	trajectory_markers.clear()

func update_trajectory_preview(drag_vector: Vector2):
	if trajectory_markers.size() == 0:
		return
		
	var camera = get_viewport().get_camera_3d()
	var force_3d = Vector3(drag_vector.x, 0, drag_vector.y).normalized()
	force_3d = camera.global_transform.basis * force_3d
	force_3d.y = 0
	
	var start_pos = global_position
	var velocity = force_3d * (drag_vector.length() / max_drag_distance) * launch_power
	
	for i in range(trajectory_markers.size()):
		var t = (i + 1) * 0.06  # Reduced time spacing by 5x (0.3 -> 0.06)
		var pos = start_pos + velocity * t
		pos.y = start_pos.y + 0.2  # Slightly above ground
		trajectory_markers[i].global_position = pos
