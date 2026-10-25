import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import edge_queue


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.db = edge_queue.connect(str(self.folder / 'queue.sqlite'))
        self.addCleanup(self.db.close)
        self.file = self.folder / 'audio.wav'
        self.file.write_bytes(b'stable test audio')
        self.batch = self.folder / 'batch.json'
        self.batch.write_text(json.dumps({'recordings': [{'id': 'rec-1'}]}))
        self.env = patch.dict(os.environ, {'BEEHAVE_API_URL': 'http://localhost:3001', 'BEEHAVE_DEVICE_KEY': 'test-only'})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.output = contextlib.redirect_stdout(io.StringIO())
        self.output.__enter__()
        self.addCleanup(self.output.__exit__, None, None, None)

    def enqueue(self):
        edge_queue.enqueue(self.db, self.batch, ['rec-1=' + str(self.file)])

    def test_enqueue_is_durable_and_duplicate_safe(self):
        self.enqueue()
        self.enqueue()
        second = edge_queue.connect(str(self.folder / 'queue.sqlite'))
        try:
            self.assertEqual(second.execute('SELECT count(*) FROM batches').fetchone()[0], 1)
            self.assertEqual(second.execute('SELECT count(*) FROM uploads').fetchone()[0], 1)
        finally:
            second.close()

    def test_network_failure_preserves_unsent_batch(self):
        self.enqueue()
        with patch.object(edge_queue, 'send', side_effect=OSError('offline')):
            with self.assertRaises(OSError):
                edge_queue.flush(self.db)
        self.assertEqual(self.db.execute('SELECT metadata_sent,completed FROM batches').fetchone(), (0, 0))
        self.assertTrue(self.file.exists())

    def test_partial_upload_resumes_without_resending_metadata(self):
        self.enqueue()
        ack = {'accepted': {'readings': 0, 'recordings': 1, 'detections': 0}}
        with patch.object(edge_queue, 'send', side_effect=[ack, OSError('upload interrupted')]):
            with self.assertRaises(OSError):
                edge_queue.flush(self.db)
        self.assertEqual(self.db.execute('SELECT metadata_sent,completed FROM batches').fetchone(), (1, 0))
        with patch.object(edge_queue, 'send', return_value={'ok': True}) as send:
            edge_queue.flush(self.db)
            self.assertEqual(send.call_count, 1)
            self.assertIn('/audio', send.call_args.args[0])
        self.assertEqual(self.db.execute('SELECT completed FROM batches').fetchone()[0], 1)
        self.assertTrue(self.file.exists())

    def test_changed_audio_is_not_uploaded(self):
        self.enqueue()
        self.file.write_bytes(b'changed')
        ack = {'accepted': {'readings': 0, 'recordings': 1, 'detections': 0}}
        with patch.object(edge_queue, 'send', return_value=ack) as send:
            with self.assertRaises(ValueError):
                edge_queue.flush(self.db)
            self.assertEqual(send.call_count, 1)
        self.assertEqual(self.db.execute('SELECT completed FROM batches').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
