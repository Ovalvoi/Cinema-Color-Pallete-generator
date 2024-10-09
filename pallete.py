import cv2
import matplotlib.pyplot as plt
import numpy as np
from tqdm import tqdm

# Function to extract dominant color from an image
def extract_dominant_color(image):
    pixels = np.float32(image.reshape(-1, 3))
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 200, 0.2)
    _, _, center = cv2.kmeans(pixels, 1, None, criteria, 10, cv2.KMEANS_RANDOM_CENTERS)
    dominant_color = center.astype(np.uint8)
    return dominant_color.squeeze()

# Open movie file
cap = cv2.VideoCapture('Avatar_compressed.mp4')

colors = []

# Get total number of frames in the video
total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

# Create progress bar
progress_bar = tqdm(total=total_frames, desc="Processing Frames", unit="frame")

batch_size = 20
frames_batch = []

# Process each frame
while cap.isOpened():
    ret, frame = cap.read()
    if not ret:
        break

    # Convert frame to RGB and resize
    frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    frame_resized = cv2.resize(frame_rgb, (100, 100))  # Adjust size as needed

    # Append to batch
    frames_batch.append(frame_resized)

    # Process batch if it reaches the desired size
    if len(frames_batch) == batch_size:
        # Convert batch to numpy array
        frames_batch = np.array(frames_batch)

        # Extract dominant colors
        batch_dominant_colors = [extract_dominant_color(frame) for frame in frames_batch]

        # Append to main color list
        colors.extend(batch_dominant_colors)

        # Clear batch
        frames_batch = []

        # Update progress bar
        progress_bar.update(batch_size)

# Release video capture and close progress bar
cap.release()
progress_bar.close()

# Switch Matplotlib backend to SVG
plt.switch_backend('svg')

# Plot color palette with adjusted colormap and increased saturation
plt.figure(figsize=(10, 1))
plt.imshow([colors], aspect='auto')
plt.axis('off')

# Save SVG figure to file
plt.savefig('output_figure.svg', format='svg', bbox_inches='tight')
