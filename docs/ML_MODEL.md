# Machine-learning experiment: predicting request acceptance

This report explains the live database-trained models and a separate neural-network research experiment.

- The **live recommendations** learn a regularized logistic-regression model from resolved request outcomes. Feature snapshots are captured when new requests are sent, before the recipient decides. See `src/lib/adaptive-recommender.js`.
- The **live NCF model** is trained by `ml/colab_live_recommender.ipynb` from eligible PostgreSQL outcomes and is loaded only when coverage and time-based quality checks pass. The older `ml/train_recommender.ipynb` experiment used fabricated data and is not loaded by the website.

## Live model used by the website

When a member sends a request, the API snapshots twelve numeric signals from the sender and recipient profiles: skill overlap, interest overlap, same department, mentor/mentee-role fit, structured mentorship-topic fit, shared accepted-network score, request type, locally computed profile text alignment, availability overlap by day, availability overlap by time window, meeting-frequency fit, and whether both availability entries could be interpreted. When the request is accepted or declined, that status becomes the training label. Pending requests and older interactions without a feature snapshot are excluded. Members should be informed that these outcomes help improve recommendations.

### How availability text becomes model input

The profile lets members select available days, an exact start/end time or full day, cadence, and how many meetings or hours they can offer per period. The app stores a readable description such as “Monday, Wednesday; 09:00-12:00; 2 meetings per week.” A deterministic parser in `src/lib/availability.js` also recognizes older text such as “weekend mornings,” “flexible,” or “2 hours/month.” It converts two members' schedules into numeric day-overlap, exact time-window overlap, and frequency-fit values. A fourth signal indicates whether both entries contained something the parser could compare. These numbers are snapshotted with each request and used by the JavaScript model, optional hosted API, and Colab acceptance/relevance models. The Colab NCF model also receives the four numeric availability values alongside pseudonymous member embeddings and request type; it never receives raw availability text. Unknown text is left unknown and shown for correction in the profile UI.

The recommendation API fits a small L2-regularized logistic-regression model to the available labeled request snapshots. It uses balanced class weights so an uneven number of acceptances or declines does not automatically dominate. This model estimates whether a request is likely to be accepted; its probability is displayed separately and never determines recommendation order. Members can rate a suggested profile's match relevance separately from usefulness ratings submitted after an accepted connection or completed mentorship. Only `MATCH_RELEVANCE` feedback trains the relevance model or enters member-judged ranking evaluation; ratings 4–5 are positive, ratings 1–2 are negative, and neutral rating 3 is ignored. Post-interaction usefulness remains a separate outcome. The cold-start profile score includes a direction-aware topic fit when members have declared seeking topics, and blends with learned relevance when feedback supports it; a department/role diversity adjustment is applied afterward.

The acceptance model needs at least 12 eligible labeled examples with at least four outcomes of each class. The relevance model needs at least eight ratings and three from each class. These minimums only permit a model to begin contributing; they are not performance guarantees. Acceptance probabilities from the local request-outcome model are descriptive and do not affect ordering. The separately quality-gated NCF acceptance estimate contributes up to 10% of the pre-diversity ranking score when a prediction exists for that member pair; candidates without an estimate fall back to profile/relevance ranking. A final diversity adjustment can change the displayed order. The recommendation card distinguishes the final ranking score from profile/member relevance and predicted acceptance likelihood.

Recommendations record served rank and component-score snapshots, plus view, dismiss, contact, and member-rating events. Completed mentorships can also collect post-experience usefulness ratings. The admin evaluation compares content, collaborative, profile hybrid, and learned relevance scores using the newest 20% of judged recommendations. It reports a group-bootstrap 95% interval and splits new from established requesters using ten prior served recommendations as the threshold. These metrics only measure among recommendations that received ratings; they are not unbiased evidence about all impressions. The admin's shared-skills/connection benchmark remains a labeled proxy diagnostic, not independent member judgment. One chronological holdout is still limited evidence; collect repeated time-based results and real member feedback before increasing NCF's influence. A last-slot exploration policy is disabled by default and requires both an explicit environment flag and minimum historical impression/feedback counts.

The live recommendation route fetches up to 750 eligible candidate IDs after database-side skill, interest, and department overlap ranking, with a per-member daily hash tie-break so equal-scoring profiles do not always lose because of ID order. It then applies the existing detailed eligibility checks and ranks the resulting candidates. This is a bounded shortlist, not a guarantee that every candidate in a very large community is scored on each request. It also limits the request-outcome and accepted-interaction histories it loads to the most recent 5,000 rows per type. Colab saves weights and metrics in Google Drive and publishes versioned artifacts to PostgreSQL, where inference reads them after Colab disconnects. Its export contains numeric features, binary labels, timestamps, and keyed pseudonyms only. Profile text, availability text, request messages, names, email addresses, and raw user IDs are not sent to Colab or the optional Python API in `ml/huggingface/`. Demo accounts and their outcomes are excluded from live training. The profile text vector is computed locally using normalized aviation phrases and weighted word/bigram vectors, emphasizing goals and mentorship topics; it is not a pretrained language model. Recommendation explanations show shared skills, aligned mentorship topics, compatible roles, known availability overlap, or broad profile-text alignment.

The administrator console exposes training counts, influence, member ratings, chronological holdout checks, and member-judged ranking diagnostics. Each classification check uses the newest fifth of dated examples and fits on older examples. It is shown only when both periods have examples from both outcome classes. These internal splits do not establish that the models are accurate, fair, or useful to real members. Consented real usage and independent evaluation are still needed. The admin's profile-overlap benchmark is a separate proxy diagnostic and does not validate the learned acceptance model.

## 1. The question the experiment asks

For a mentorship or connection request between two stakeholders, can a model estimate whether the request will be **accepted** or **declined**?

This is a binary classification problem: the model returns a number between 0 and 1. A number closer to 1 means “the model predicts acceptance”; a number closer to 0 means “the model predicts decline.” The experiment converts that score to a class using a 0.5 threshold for accuracy, precision, recall, and F1 calculations.

It is not the same task as the live recommender, which ranks people using profile overlap and accepted network relationships. The trained model predicts outcomes for request pairs; it does not decide which profiles should appear in the live recommendations list.

## 2. Data used

The experiment reads the fabricated demonstration records in `prisma/data/stakeholders.csv` and `prisma/data/interactions.csv`:

- 150 synthetic stakeholders.
- 441 request records in total: 208 mentorship and 233 connection requests.
- 69 pending requests are excluded because their outcomes are not known.
- 372 labeled requests remain: 198 accepted and 174 declined.
- Each labeled sender-recipient pair appears once. There are no repeated labeled pairs.

The requests are split at random, while preserving the acceptance/decline ratio, into 237 training rows, 60 validation rows, and 75 test rows. A row means one observed request. The same stakeholder can appear in more than one split through different request pairs, so this tests prediction for held-out interactions among the known synthetic users. It does not test generalization to entirely new users.

The data contains fabricated names and interactions, not records from Kenya Airways. The results therefore describe this experiment and dataset only.

## 3. What the model is

The notebook uses a small **Neural Collaborative Filtering (NCF)** architecture. “Neural” means the parameters are learned by a neural network during training. “Collaborative” means it tries to learn patterns from user interaction records.

### Inputs

For each request, the model receives:

1. The sender's stakeholder ID.
2. The recipient's stakeholder ID.
3. The request type, represented as two values: mentorship or connection.

The model does not currently receive profile skills, interests, departments, message text, ratings, or dates.

### Learned representation and network

Each of the 150 users is assigned a learned vector of 8 numbers, called an **embedding**. The model looks up one vector for the sender and one for the recipient. It joins those 16 numbers with the 2 request-type values, then passes the 18-number input through a dense layer with 16 units and a ReLU activation. A final layer and sigmoid function produce the acceptance score.

```text
sender ID ───────┐
                 ├─ 8-number user vectors ─┐
recipient ID ────┘                         ├─ 16-unit neural layer ─ output 0…1
request type ───────────── 2 values ───────┘
```

The embedding vectors start as learned parameters and are adjusted during training. They are not hand-written descriptions of a person's skills or personality.

### Training choices

- **Loss:** binary cross-entropy, which penalizes the model when its predicted probability is far from the known accepted/declined label.
- **Optimizer:** Adam, learning rate 0.005.
- **Regularization:** weight decay 0.01, which discourages excessively large learned parameters.
- **Training style:** full-batch, appropriate for this very small dataset.
- **Early stopping:** after 30 epochs without improved validation loss, training stops. The checkpoint with the best validation loss is used for the final test calculation.
- **Random seed:** 42 for NumPy and PyTorch operations in the notebook.

The model is intentionally small. With only 372 labeled examples, a larger network would have a high risk of memorizing training examples instead of learning patterns that transfer.

## 4. Results currently recorded

The checked-in values are in `ml/artifacts/metrics.json` and are summarized below.

| Test measure | Recorded result | Meaning |
|---|---:|---|
| Accuracy | 0.520 | Correct class on 52% of held-out rows at the 0.5 threshold. |
| Precision | 0.534 | Of rows predicted accepted, about 53% were accepted. |
| Recall | 0.775 | Of accepted test requests, about 78% were predicted accepted. |
| F1 | 0.633 | A single score balancing precision and recall. |
| ROC-AUC | 0.498 | Ability to rank accepted requests above declined ones; 0.5 is chance-level ranking. |
| Majority-class accuracy baseline | 0.532 | Accuracy from always predicting the more common class in the labeled dataset. |

The result does **not** show useful predictive performance: test accuracy is below the majority-class baseline, and ROC-AUC is approximately 0.5. High recall alone does not mean the predictions are good; the model can identify many accepted requests while also making many incorrect acceptance predictions.

### About the recorded “Precision@5” field

The checked-in `precision_at_5` value (`0.0278`) is a historical output from an earlier version of the notebook. That version divided the top-five hits by `min(5, number of accepted test requests for that sender)`, which is not standard Precision@5 when fewer than five accepted examples exist. The notebook cell has now been corrected: it divides hits by the number of ranked candidates (five here) and excludes the sender from their own candidate list. The checked-in metric artifact has **not** been regenerated with the corrected calculation, so do not quote its `precision_at_5` field as a standard metric. Rerun the notebook to produce a current value.

The classification metrics above and this ranking-style value are separate measurements. Neither is the live admin endpoint's profile-ranking diagnostic.

## 5. What the data sparsity means

Although each stakeholder may occur in several different requests, every individual sender-recipient pair occurs only once. There is consequently no repeated outcome for the same pair, and only a small number of request examples per stakeholder. That gives the embeddings little evidence from which to learn stable preferences. The random row split also leaves users in both training and test sets, so the experiment says nothing about brand-new users whose IDs were never seen during training.

The observed chance-level ROC-AUC is evidence that this particular model and dataset did not produce useful held-out predictions. It is not proof that all collaborative filtering methods must fail, or that the live hybrid recommender is empirically validated. The live system's content-heavy cold-start schedule is a reasoned prototype choice; it still needs independent evaluation with real, consented interaction data.

The plots in `ml/artifacts/loss_curve.png` and `ml/artifacts/embedding_space.png` are exploratory diagnostics. A two-dimensional PCA visualization is a compressed view of the learned vectors; visual clusters (or lack of clusters) alone do not establish model quality.

## 6. Older fabricated-data NCF experiment

The old `ml/train_recommender.ipynb` results do not support using that experiment's predictions to rank stakeholders. Its checkpoint and exported embeddings remain research outputs. The live NCF model is trained separately by `ml/colab_live_recommender.ipynb` from eligible database outcomes, and its artifact is activated only after the live-data checks pass.

The live logistic models fit from eligible request and feedback examples stored in PostgreSQL. The live NCF artifact is versioned in PostgreSQL after Colab trains it from the protected live-data export. Model training exports exclude demo users. No always-running Colab session is required for inference; the app loads stored artifact weights and computes predictions itself. If evidence or quality checks fail, NCF stays inactive and profile/network matching supports cold start. The older `ml/train_recommender.ipynb` notebook remains a fabricated-data experiment only.

## 7. How to reproduce the experiment

1. Open `ml/train_recommender.ipynb` in Google Colab (or a compatible Python environment).
2. Provide `prisma/data/stakeholders.csv` and `prisma/data/interactions.csv`. In Colab, use a `GITHUB_TOKEN` secret with repository read access, or upload the files when prompted.
3. Run the notebook from top to bottom. It can use CPU; a GPU is optional for this dataset.
4. Review the training and validation loss, test metrics, and generated plots.
5. The notebook writes metrics, embeddings, and figures to `/content/artifacts/` and checkpoints to Google Drive when mounted. Compare newly produced outputs with the checked-in files before replacing the recorded results.

See [`ml/README.md`](../ml/README.md) for setup details and [`docs/DATA.md`](DATA.md) for the seed dataset description.

## 8. What a stronger follow-up evaluation needs

- More real, consented request outcomes collected over time.
- A clear evaluation split. For future-user performance, split by user; for future-time performance, train on earlier requests and test on later ones.
- Baseline models, including a majority-class predictor and simple profile or user-history methods.
- Metrics chosen for the task, with each definition and denominator stated explicitly.
- Separate validation from final test decisions, and avoid tuning on the test set.
- Member feedback or relevance judgments to assess whether suggested mentors are actually useful.
- Privacy controls and data minimization before any real organizational data is used.
