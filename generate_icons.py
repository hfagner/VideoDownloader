import os
from PIL import Image, ImageDraw

def create_icon(size, active, filename):
    # Create a transparent background
    img = Image.new('RGBA', (size, size), (255, 255, 255, 0))
    draw = ImageDraw.Draw(img)
    
    # Coordinates and colors for the 3 balls
    # Arrangement: one top, two bottom (forming a triangle)
    r = size * 0.22 # radius
    
    # Centers
    cx = size / 2
    cy = size / 2
    
    top_c = (cx, cy - r * 0.8)
    left_c = (cx - r * 1.0, cy + r * 0.8)
    right_c = (cx + r * 1.0, cy + r * 0.8)
    
    if active:
        colors = [(255, 0, 0, 255), (0, 0, 255, 255), (255, 255, 0, 255)] # Red, Blue, Yellow
    else:
        gray = (128, 128, 128, 255)
        colors = [gray, gray, gray]
        
    centers = [top_c, left_c, right_c]
    
    for i in range(3):
        x, y = centers[i]
        draw.ellipse([x - r, y - r, x + r, y + r], fill=colors[i], outline=(0,0,0,255), width=int(max(1, size*0.03)))
        
    img.save(filename, "PNG")

def main():
    icons_dir = "icons"
    if not os.path.exists(icons_dir):
        os.makedirs(icons_dir)
        
    sizes = [16, 32, 48, 128]
    for size in sizes:
        create_icon(size, False, os.path.join(icons_dir, f"icon-{size}.png"))
        create_icon(size, True, os.path.join(icons_dir, f"icon-active-{size}.png"))
        print(f"Generated icons for size {size}")

if __name__ == "__main__":
    main()
