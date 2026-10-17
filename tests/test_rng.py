"""The portable dice: mulberry32 must give the JS port the very same numbers."""

from __future__ import annotations

import unittest

from gameofailife.rng import Rng, r2


class ParityTest(unittest.TestCase):
    def test_first_draws_of_7920_match_the_js_twin(self):
        rng = Rng(7920)  # the cast stream of seed 1: 1 * 7919 + 1
        self.assertEqual([f"{rng.random():.12f}" for _ in range(3)], ["0.166736019310", "0.824670854257", "0.208481384674"])

    def test_seeds_wrap_modulo_2_32(self):
        for seed, same in ((-1, 0xFFFFFFFF), (2 ** 32 + 5, 5), (-3 * 7919 + 1, (-3 * 7919 + 1) % 2 ** 32)):
            a, b = Rng(seed), Rng(same)
            self.assertEqual([a.next_u32() for _ in range(5)], [b.next_u32() for _ in range(5)])

    def test_draws_are_32_bit_fractions(self):
        rng = Rng(1)
        for _ in range(1000):
            u = rng.random()
            self.assertTrue(0.0 <= u < 1.0)
            self.assertEqual(u * 2 ** 32, int(u * 2 ** 32))


class DrawsTest(unittest.TestCase):
    def test_int_stays_in_bounds_and_hits_both_ends(self):
        rng = Rng(99)
        for lo, hi in ((0, 8), (-4, 4), (5, 6), (66, 80), (7, 7)):
            seen = {rng.int(lo, hi) for _ in range(400)}
            self.assertLessEqual(seen, set(range(lo, hi + 1)))
            self.assertIn(lo, seen)
            self.assertIn(hi, seen)

    def test_int_is_lo_plus_floor_of_scaled_draw(self):
        a, b = Rng(3), Rng(3)
        for _ in range(50):
            self.assertEqual(a.int(-4, 4), -4 + int(b.random() * 9))

    def test_uniform_and_pick(self):
        rng = Rng(5)
        for _ in range(200):
            self.assertTrue(0.2 <= rng.uniform(0.2, 0.8) < 0.8)
        items = ["a", "b", "c"]
        self.assertEqual({rng.pick(items) for _ in range(100)}, set(items))

    def test_shuffle_is_a_deterministic_permutation(self):
        base = list(range(24))
        a, b = list(base), list(base)
        Rng(42).shuffle(a)
        Rng(42).shuffle(b)
        self.assertEqual(a, b)
        self.assertEqual(sorted(a), base)
        self.assertNotEqual(a, base)
        c = list(base)
        Rng(43).shuffle(c)
        self.assertNotEqual(a, c)

    def test_shuffle_is_fisher_yates_from_the_end(self):
        seq = ["w", "x", "y", "z"]
        rng, ref = Rng(8), Rng(8)
        want = list(seq)
        for i in range(len(want) - 1, 0, -1):
            j = int(ref.random() * (i + 1))
            want[i], want[j] = want[j], want[i]
        rng.shuffle(seq)
        self.assertEqual(seq, want)

    def test_r2_rounds_half_up(self):
        self.assertEqual(r2(0.125), 0.13)
        self.assertEqual(r2(0.5049), 0.5)
        self.assertEqual(r2(-0.125), -0.12)
        self.assertEqual(Rng.r2(0.375), 0.38)


if __name__ == "__main__":
    unittest.main()
