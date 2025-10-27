// package main

// import (
// 	"fmt"
// 	"log"
// )

// func main() {
// 	rootDir := "/data/2q9e4r6Mu3U68nU1fYjgbR6JvwrRx36CohpAX5UQxse55x1Q5_v2"

// 	fmt.Printf("Checking available blocks in %s\n", rootDir)

// 	ranges, err := ListAvailableRanges(rootDir)
// 	if err != nil {
// 		log.Fatalf("Error listing ranges: %v", err)
// 	}

// 	if len(ranges) == 0 {
// 		fmt.Println("No blocks found yet")
// 		return
// 	}

// 	fmt.Printf("Found %d block files:\n", len(ranges))
// 	for i, r := range ranges {
// 		fmt.Printf("  %s\n", r)
// 		if i >= 10 && len(ranges) > 12 {
// 			fmt.Printf("  ... and %d more\n", len(ranges)-11)
// 			break
// 		}
// 	}
// }
