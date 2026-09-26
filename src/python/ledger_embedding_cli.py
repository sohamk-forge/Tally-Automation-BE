# src/python/embed_cli.py
import sys
import json
from sentence_transformers import SentenceTransformer

model = SentenceTransformer("all-MiniLM-L6-v2")

def main():
    raw = sys.stdin.read()
    payload = json.loads(raw)
    texts = payload if isinstance(payload, list) else [payload]

    embeddings = model.encode(texts, normalize_embeddings=True)
    result = [emb.tolist() for emb in embeddings]

    print(json.dumps(result))

if __name__ == "__main__":
    main()