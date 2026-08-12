UPDATE project_controls
SET operating_state = 'Not Set'
WHERE operating_state = 'Stable'
  AND COALESCE(updated_at, '') = ''
  AND COALESCE(updated_by, '') = ''
  AND COALESCE(next_outcome, '') = ''
  AND COALESCE(next_move_owner, '') = ''
  AND COALESCE(next_action, '') = ''
  AND COALESCE(response_date, '') = ''
  AND COALESCE(review_date, '') = ''
  AND COALESCE(blocker_reason, '') = '';
