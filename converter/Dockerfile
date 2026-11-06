# syntax=docker/dockerfile:1
#
# The PDF converter: sheet-to-ly's recognizer behind a small HTTP server. Its
# code and weights come from a sheet-to-ly checkout, see `npm run converter:build`.
FROM python:3.12-slim

# Pulled in by rapidocr's opencv dependency.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir \
  --extra-index-url https://download.pytorch.org/whl/cpu \
  -r /tmp/requirements.txt

WORKDIR /app
COPY --from=sheet-to-ly sheet2ly ./sheet2ly
# The checkpoints sheet2ly picks by default, at the paths it looks for them.
COPY --from=sheet-to-ly runs/strip_v4/final.pt ./runs/strip_v4/final.pt
COPY --from=sheet-to-ly runs/staffnet_v2/last.pt ./runs/staffnet_v2/last.pt
COPY --from=sheet-to-ly runs/header_v3/best.pt ./runs/header_v3/best.pt
COPY server.py ./server.py

# The container runs without internet, so the OCR models have to be in the image.
RUN python -c "from rapidocr import RapidOCR; RapidOCR()"

# Torch counts the host's cores, not the instance's. Keep in step with instanceType.
ENV OMP_NUM_THREADS=4 MKL_NUM_THREADS=4 PYTHONUNBUFFERED=1 SHEET2LY_DEVICE=cpu SHEET2LY_OCR=rapid
EXPOSE 8080
CMD ["python", "server.py"]
