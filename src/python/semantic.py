import re

try:
    from sentence_transformers import SentenceTransformer
    from sklearn.cluster import AgglomerativeClustering
    model = SentenceTransformer('all-MiniLM-L6-v2')
    SEMANTIC_AVAILABLE = True
except ImportError:
    SEMANTIC_AVAILABLE = False
    model = None


def clean_narration(text):
    text = str(text).upper()

    # Strip trailing ref number + everything after (PAID VIA CRED, PAYMENT FROM PHONE etc.)
    text = re.sub(r'-\d{6,}-.*$', '', text)

    # Strip UPI handle + domain (@YBL, @OKBIZAXIS, @AXISBANK etc.)
    text = re.sub(r'@[A-Z0-9]+', '', text)

    # Strip bank IFSC-style codes (e.g. SBIN0018715, BARB0KOPERG, YESB0YBLUPI, UTIB0000553)
    text = re.sub(r'\b[A-Z]{4}[0-9][A-Z0-9]{5,}\b', '', text)

    # Strip remaining short bank codes after dash (e.g. -UTIB, -SBIN, -ICIC, -YBL, -IBL)
    text = re.sub(r'-[A-Z]{2,6}\b', '', text)

    # Strip payment keywords
    text = re.sub(
        r'\b(UPI|AUTOPAY|NEFT|IMPS|RTGS|POS|ATM|ACH D|'
        r'PAID VIA CRED|PAYMENT ON CRED|PAYMENT FROM PHONE|'
        r'UPI PAY|MANDATEEXECUTE|PAYTOSHADOWFAXTECH|'
        r'PAY TO BHARATPE ME|GPAY)\b',
        '', text
    )

    # Strip phone/account numbers (6+ digits or digit-dash combos)
    text = re.sub(r'[\d\-]{6,}', '', text)

    # Strip single standalone characters
    text = re.sub(r'\b[A-Z]\b', '', text)

    # Replace dots and dashes with spaces, clean extra spaces
    text = re.sub(r'[.\-]+', ' ', text)
    text = re.sub(r'\s+', ' ', text).strip()

    return text if text.strip() else "UNKNOWN"


def process_transactions(transactions):
    if not transactions:
        return []

    # Extract narrations
    narrations = [txn.get("narration", "") for txn in transactions]

    # Clean narrations
    cleaned = [clean_narration(n) for n in narrations]

    # Default: use cleaned narration as group key (same merchant = same group_key)
    group_keys = [c.lower().strip().replace(" ", "_") for c in cleaned]

    # If semantic model available, use clustering to find similar ones
    # and assign the SAME group_key to all transactions in a cluster
    if SEMANTIC_AVAILABLE and len(transactions) > 1:
        try:
            embeddings = model.encode(cleaned)
            clustering = AgglomerativeClustering(
                n_clusters=None,
                distance_threshold=0.15,
                metric='cosine',
                linkage='average'
            )
            labels = clustering.fit_predict(embeddings)

            # For each cluster, pick the first merchant name as the group_key
            # So all transactions in same cluster share same group_key
            cluster_representative = {}
            for i, label in enumerate(labels):
                label = int(label)
                if label not in cluster_representative:
                    # Use cleaned name of first transaction in this cluster
                    cluster_representative[label] = cleaned[i].lower().strip().replace(" ", "_")

            # Assign group_key based on cluster
            group_keys = [
                cluster_representative[int(labels[i])]
                for i in range(len(transactions))
            ]

        except Exception:
            pass  # fallback to cleaned narration as group_key

    # Attach back to transactions — no cluster_id, just merchant_name and group_key
    for i, txn in enumerate(transactions):
        txn["merchant_name"] = cleaned[i]
        txn["group_key"]     = group_keys[i]
        # Remove cluster_id if it exists
        txn.pop("cluster_id", None)

    return transactions