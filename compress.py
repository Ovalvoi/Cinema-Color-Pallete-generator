import subprocess

def compress_video(input_file, output_file, bitrate='150k', frame_size='100x100', frame_rate=7.5):
    # FFmpeg command for video compression with audio removed
    command = [
        'ffmpeg',
        '-i', input_file,
        '-c:v', 'libx265',     # H.265 (HEVC) video codec
        '-b:v', bitrate,       # Video bitrate (300 kbps)
        '-s', frame_size,      # Frame size (640x360)
        '-r', str(frame_rate), # Frame rate (15 fps)
        '-an',                 # Remove audio completely
        output_file
    ]

    # Execute FFmpeg command
    try:
        subprocess.run(command, check=True)
        print("Compression successful!")
    except subprocess.CalledProcessError as e:
        print("Compression failed:", e)

# Example usage
input_video = 'Avatar.mkv'
output_video = 'Avatar_compressed.mp4'
compress_video(input_video, output_video)
