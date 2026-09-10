from typing import List


class Solution:
    def twoSum(self, nums: List[int], target: int) -> List[int]:
        num_to_index = {}
        for index, num in enumerate(nums):
            complement = target - num
            if complement in num_to_index:
                return [num_to_index[complement], index]
            num_to_index[num] = index
        return []

print(Solution().twoSum([2, 7, 11, 15], 9))  # Output: [0, 1]