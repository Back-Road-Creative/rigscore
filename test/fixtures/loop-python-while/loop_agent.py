import subprocess
import time

while True:
    subprocess.run(["claude", "-p", "fix the build"], check=False)
    time.sleep(30)
