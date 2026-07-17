import re

try:
    from sentence_transformers import SentenceTransformer
    from sklearn.cluster import AgglomerativeClustering
    model = SentenceTransformer('all-MiniLM-L6-v2')
    SEMANTIC_AVAILABLE = True
except ImportError:
    SEMANTIC_AVAILABLE = False
    model = None

# Cleaned narrations shorter than this (or equal to "UNKNOWN") are treated
# as "not meaningful" — see note in process_transactions() below.
MIN_MEANINGFUL_LENGTH = 3

# Cosine distance threshold for AgglomerativeClustering. Lowered from 0.15
# to 0.12 to reduce false merges between genuinely different merchants.
CLUSTER_DISTANCE_THRESHOLD = 0.12


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


def _is_meaningful(cleaned_text):
    return cleaned_text != "UNKNOWN" and len(cleaned_text) >= MIN_MEANINGFUL_LENGTH


def _to_key(cleaned_text):
    return cleaned_text.lower().strip().replace(" ", "_")


def extract_anchor_number(raw_text):
    """
    clean_narration() strips every 6+ digit run as noise (transaction IDs,
    timestamps, phone numbers). That's usually right, but for things like
    EMI/loan payments the account/loan number is ALSO 6+ digits and repeats
    every month — stripping it turns two DIFFERENT loans into the same
    generic text (e.g. "EMI CHQ"), so they'd wrongly merge into one group.

    Heuristic: if a digit run appears more than once in the raw narration —
    either verbatim, or as a prefix of a longer run elsewhere (e.g.
    "154498149" is a prefix of "154498149120") — treat it as a recurring
    reference/account number worth keeping, rather than a one-off ID.
    Returns the anchor number as a string, or None if nothing repeats.
    """
    digit_runs = re.findall(r'\d{6,}', str(raw_text))
    if len(digit_runs) < 2:
        return None

    for i, run in enumerate(digit_runs):
        for j, other in enumerate(digit_runs):
            if i != j and run != other and other.startswith(run):
                return run

    seen = {}
    for run in digit_runs:
        seen[run] = seen.get(run, 0) + 1
    for run, count in seen.items():
        if count > 1:
            return run

    return None


def process_transactions(transactions):
    if not transactions:
        return []

    narrations = [txn.get("narration", "") for txn in transactions]
    cleaned_base = [clean_narration(n) for n in narrations]

    # Fold any recurring reference/loan number back into the cleaned text
    # BEFORE it's used to build the group key or feed the embeddings. This
    # is what stops two different EMI loans (or any other recurring-payment
    # narration) from both cleaning down to the same generic phrase (e.g.
    # "EMI CHQ") and being wrongly treated as the same merchant.
    anchors = [extract_anchor_number(n) for n in narrations]
    cleaned = [
        f"{c} {a}" if (a and c != "UNKNOWN") else c
        for c, a in zip(cleaned_base, anchors)
    ]

    # IMPORTANT: transactions whose narration collapses to nothing meaningful
    # (blank, "UNKNOWN", or too short after stripping) must NOT be grouped
    # with each other. Previously they all fell back to the same literal
    # group_key ("unknown"), so completely unrelated transactions from
    # different parties ended up sharing one merchant/group — which is
    # exactly the "wrong data" the semantic step was producing. Each such
    # transaction now gets its own unique, un-groupable key and is reported
    # with no merchant_name/group_key at all.
    group_keys = [None] * len(transactions)
    for i, c in enumerate(cleaned):
        group_keys[i] = _to_key(c) if _is_meaningful(c) else f"__ungroupable_{i}__"

    meaningful_idx = [i for i, c in enumerate(cleaned) if _is_meaningful(c)]

    if SEMANTIC_AVAILABLE and len(meaningful_idx) > 1:
        try:
            meaningful_cleaned = [cleaned[i] for i in meaningful_idx]
            embeddings = model.encode(meaningful_cleaned)
            clustering = AgglomerativeClustering(
                n_clusters=None,
                distance_threshold=CLUSTER_DISTANCE_THRESHOLD,
                metric='cosine',
                linkage='average'
            )
            labels = clustering.fit_predict(embeddings)

            def tokens(s):
                return set(s.split())

            def numeric_tokens(tok_set):
                return {t for t in tok_set if t.isdigit()}

            # Guard rail against pure semantic drift: the embedding model can
            # rate two different merchants as "similar" (e.g. both are short
            # generic phrases). We only trust a cluster merge when the two
            # cleaned narrations also share at least one real token in
            # common with the cluster's representative. Otherwise the
            # transaction is kept in its own group rather than silently
            # mislabeled with someone else's merchant name.
            #
            # Special case: if either side carries a numeric anchor token
            # (e.g. a loan/account number folded in above), a shared generic
            # word like "EMI"/"CHQ" is NOT enough to merge — two different
            # loans both say "EMI CHQ". In that case the numeric anchors
            # themselves must match.
            cluster_rep_tokens = {}   # label -> (representative cleaned text, its tokens)
            resolved_keys = {}        # original transaction index -> group_key

            for pos, label in enumerate(labels):
                label = int(label)
                orig_idx = meaningful_idx[pos]
                my_text = meaningful_cleaned[pos]
                my_tokens = tokens(my_text)

                if label not in cluster_rep_tokens:
                    cluster_rep_tokens[label] = (my_text, my_tokens)
                    resolved_keys[orig_idx] = _to_key(my_text)
                    continue

                rep_text, rep_tokens = cluster_rep_tokens[label]
                my_nums = numeric_tokens(my_tokens)
                rep_nums = numeric_tokens(rep_tokens)

                if my_nums or rep_nums:
                    is_match = bool(my_nums & rep_nums)
                else:
                    is_match = bool(my_tokens & rep_tokens)

                if is_match:
                    resolved_keys[orig_idx] = _to_key(rep_text)
                else:
                    # Either no shared wording, or a numeric anchor that
                    # doesn't match — don't force it into that group.
                    resolved_keys[orig_idx] = _to_key(my_text)

            for orig_idx, key in resolved_keys.items():
                group_keys[orig_idx] = key

        except Exception:
            pass  # fall back to the per-transaction cleaned-narration keys set above

    for i, txn in enumerate(transactions):
        meaningful = _is_meaningful(cleaned[i])
        txn["merchant_name"] = cleaned[i] if meaningful else ""
        txn["group_key"] = group_keys[i] if meaningful else None
        txn.pop("cluster_id", None)

    return transactions