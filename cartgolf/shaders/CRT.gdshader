shader_type canvas_item;

// Fullscreen texture
uniform sampler2D SCREEN_TEXTURE : hint_screen_texture, filter_linear_mipmap;

// Simple CRT parameters
uniform float scanline_width : hint_range(1.0, 100.0) = 100.0;  // pixels per scanline
uniform vec4 scanline_tint : source_color = vec4(0.95, 1.0, 0.95, 1.0); // dark stripes

void fragment() {
    vec2 uv = SCREEN_UV;
    vec3 col = texture(SCREEN_TEXTURE, uv).rgb;

    float screen_height = 1.0 / SCREEN_PIXEL_SIZE.y;
    float y_pix = uv.y * screen_height;

    // Alternating stripes
    float stripe = mod(floor(y_pix / scanline_width), 2.0);
    col *= mix(vec3(1.0), scanline_tint.rgb, stripe);

    COLOR = vec4(col, 1.0);
}
